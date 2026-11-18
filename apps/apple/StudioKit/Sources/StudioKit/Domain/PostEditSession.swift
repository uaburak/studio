import CoreGraphics
import Foundation
import Observation

/// An opened post and its editor, without any UI: the iPhone's post screen runs on it,
/// and it follows the same rules as the Mac's `PostDetailModel` (P1).
///
/// Every design change goes through the API's patch path: the edit becomes design-kit
/// patch ops, a `content.render` job stores a new `manual_edit` version and renders it,
/// and the session swaps in the new version when the job is done. Undo restores the
/// version before the edit (a new version with the same hash), redo the edited one.
/// Edits sent while another edit renders wait and go out right after, on the new version.
@MainActor
@Observable
public final class PostEditSession {
    /// What the post is busy with; edits queue behind a version change.
    public enum Activity: Hashable, Sendable {
        case idle
        case uploading(Double)
        case rendering(String)
        case measuring
        case revising(String)
        case restoring

        public var isBusy: Bool { self != .idle }

        /// Busy with something that changes the version (measuring boxes does not).
        public var changesVersion: Bool { self != .idle && self != .measuring }

        public var message: String {
            switch self {
            case .idle: ""
            case .uploading(let p): "Görsel yükleniyor %\(Int((p * 100).rounded()))"
            case .rendering(let m): m.isEmpty ? "Render ediliyor" : m
            case .measuring: "Katmanlar ölçülüyor"
            case .revising(let m): m.isEmpty ? "AI düzenliyor" : m
            case .restoring: "Sürüm geri yükleniyor"
            }
        }
    }

    /// One undoable change: the version before it and the version it produced.
    public struct EditStep: Equatable, Sendable {
        public var before: Int
        public var after: Int
        public var name: String

        public init(before: Int, after: Int, name: String) {
            self.before = before
            self.after = after
            self.name = name
        }
    }

    public let service: any StudioDataService
    public private(set) var card: PostCard
    public private(set) var displayedVersion: ContentVersion? {
        didSet {
            guard oldValue?.id != displayedVersion?.id else { return }
            if oldValue?.version != displayedVersion?.version { checksReloadTask?.cancel(); checksReloadTask = Task { [weak self] in await self?.loadChecks() } }
        }
    }
    public private(set) var versionSummaries: [ContentVersionSummary] = []
    public private(set) var selectedSlideIndex = 0
    /// Selected `data-layer` id on the current slide.
    public var selectedLayerId: String?
    public private(set) var activity: Activity = .idle
    /// Boxes (artboard px) of layers moved while their render runs.
    public private(set) var previewBoxes: [String: CGRect] = [:]

    public var captionDraft: String
    public var hashtagsDraft: String
    public private(set) var isSavingCaption = false

    /// "Neyi değiştireyim?"
    public var instruction = ""
    public private(set) var revisionJobId: EntityID?

    public private(set) var isApproving = false
    public private(set) var isScheduling = false
    public private(set) var isExporting = false
    public private(set) var exportMessage: String?

    public private(set) var undoStack: [EditStep] = []
    public private(set) var redoStack: [EditStep] = []

    public var error: String?
    /// Short confirmation ("Açıklama kaydedildi").
    public var notice: String?

    /// Latest production check run of the shown version (nil: never checked, or not read yet).
    public private(set) var checkRun: ContentCheckRun?
    /// The version `checkRun` was read for (nil until read).
    public private(set) var checkRunVersion: Int?
    public private(set) var isLoadingChecks = false
    public private(set) var checksError: String?
    public private(set) var isStartingChecks = false
    /// Running jobs of this post that store check runs (`content.check`, generation, render).
    public private(set) var activeJobs: [EntityID: Job] = [:]

    /// The card changed (content and/or its current version); keep lists in step.
    @ObservationIgnored public var onCardChange: (@MainActor (PostCard) -> Void)?
    /// Schedules created by `schedule(at:accountIds:)`.
    @ObservationIgnored public var onSchedulesCreated: (@MainActor ([Schedule]) -> Void)?
    /// A picture was uploaded (seed thumbnails with it).
    @ObservationIgnored public var onAssetUploaded: (@MainActor (Asset, UploadFile) -> Void)?
    /// Whether a Mac worker is connected (layer measuring needs one).
    @ObservationIgnored public var workerOnline: @MainActor () -> Bool = { true }
    /// The chat (S1): an AI request about a canvas version is a message to the post's
    /// conversation, as on the Mac (nil: such a request is refused with a note).
    @ObservationIgnored public var chat: (any PostChatSender)?
    /// Which conversation each post's requests go to on this phone.
    @ObservationIgnored public var postConversations: PostConversations = .shared
    @ObservationIgnored private var revisionRunId: EntityID?

    @ObservationIgnored public var jobTimeout: Duration = .seconds(180)
    @ObservationIgnored public var revisionTimeout: Duration = .seconds(1200)
    @ObservationIgnored public var pollInterval: Duration = .milliseconds(400)
    /// How long arrow nudges rest before they go out as one edit.
    @ObservationIgnored public var nudgeDebounce: Duration = .milliseconds(450)

    @ObservationIgnored private var pendingTransforms: [String: LayerTransform] = [:]
    @ObservationIgnored private var queuedPatches: [DesignPatch] = []
    @ObservationIgnored private var queuedName = ""
    @ObservationIgnored private var measuredVersionIds: Set<EntityID> = []
    @ObservationIgnored private var nudgeTask: Task<Void, Never>?
    @ObservationIgnored private var nudgeDelta: CGSize = .zero
    @ObservationIgnored private var editTask: Task<Void, Never>?
    @ObservationIgnored private var checksReloadTask: Task<Void, Never>?
    @ObservationIgnored private var canvasCache: (versionId: EntityID, origin: CanvasOrigin?)?

    public init(service: any StudioDataService, card: PostCard) {
        self.service = service
        self.card = card
        self.displayedVersion = card.version
        let parts = CaptionParts(caption: card.content.caption)
        captionDraft = parts.body
        hashtagsDraft = parts.hashtags.joined(separator: " ")
    }

    /// `StudioAPIError`'s Turkish text, else the error's own description.
    public static func describe(_ error: any Error) -> String {
        if let api = error as? StudioAPIError, let text = api.errorDescription { return text }
        if let wait = error as? JobWaitError, let text = wait.errorDescription { return text }
        return error.localizedDescription
    }

    // MARK: - Derived

    public var content: Content { card.content }
    public var activeVersion: ContentVersion? { displayedVersion ?? card.version }
    public var slides: [Slide] { activeVersion?.slides ?? [] }
    public var currentSlide: Slide? { slides.indices.contains(selectedSlideIndex) ? slides[selectedSlideIndex] : nil }
    public var artboardSize: CGSize { CGSize(width: currentSlide?.width ?? 1080, height: currentSlide?.height ?? 1350) }

    public var isViewingCurrentVersion: Bool {
        guard let current = content.currentVersion?.version, let shown = activeVersion?.version else { return true }
        return current == shown
    }

    public var canApprove: Bool {
        isViewingCurrentVersion && card.approvableHash != nil && !isApproving && !activity.changesVersion
    }

    /// Why approving is not possible right now (nil when it is).
    public var approveBlocker: String? {
        if content.status.hasApproval { return "Bu post onaylandı." }
        if activity.changesVersion { return "Değişiklik render edilirken onaylanamaz." }
        if !isViewingCurrentVersion { return "Eski bir sürümü görüntülüyorsun; önce güncel sürüme dön ya da bu sürümü geri yükle." }
        if content.currentVersion == nil { return "Henüz bir sürüm yok." }
        if card.version == nil { return "Sürüm yükleniyor." }
        if card.approvableHash == nil { return "Gösterilen sürüm Mac'tekiyle eşleşmiyor; yenile." }
        return nil
    }

    /// The shown version was saved from the Mac's design canvas (Wecra): its layers are not
    /// edited on the phone, and AI requests go to the HTML version it came from.
    public var canvasOrigin: CanvasOrigin? {
        guard let version = activeVersion else { return nil }
        if let cached = canvasCache, cached.versionId == version.id { return cached.origin }
        let origin = version.canvasOrigin
        canvasCache = (version.id, origin)
        return origin
    }

    public var isCanvasVersion: Bool { canvasOrigin != nil }

    /// Why the design cannot be edited right now (nil = it can).
    public var editBlocker: String? {
        if content.type == .reel { return "Reels tasarımı telefondan düzenlenmiyor." }
        if content.status.isLocked { return "Yayındaki post düzenlenemez." }
        guard activeVersion != nil else { return "Henüz bir tasarım sürümü yok." }
        if isCanvasVersion { return CanvasOrigin.editNote }
        if !isViewingCurrentVersion { return "Eski bir sürümü görüntülüyorsun; düzenlemek için önce geri yükle." }
        if case .revising = activity { return "AI düzenlemesi sürüyor." }
        if activity == .restoring { return "Sürüm geri yükleniyor." }
        return nil
    }

    public var canEdit: Bool { editBlocker == nil }
    public var canUndo: Bool { !undoStack.isEmpty && !activity.changesVersion }
    public var canRedo: Bool { !redoStack.isEmpty && !activity.changesVersion }

    /// `[data-layer]` elements of the current slide, in document order.
    public var layers: [SlideLayer] {
        guard let slide = currentSlide else { return [] }
        return SlideLayerScanner.layers(inHTML: slide.html, slideIndex: selectedSlideIndex)
    }

    /// Layers worth listing in an editor: text, pictures, slots, logos and shapes.
    public var editableLayers: [SlideLayer] {
        layers.filter { $0.kind != .group && $0.kind != .other }
    }

    /// Measured boxes of the current slide (nil until a render measured them).
    public var layerBoxes: [SlideLayerBox]? { currentSlide?.layers }

    public var selectedLayer: SlideLayer? { selectedLayerId.flatMap { id in layers.first { $0.layerId == id } } }

    public func box(for layerId: String) -> CGRect? {
        if let preview = previewBoxes[layerId] { return preview }
        return layerBoxes?.first { $0.id == layerId }?.rect
    }

    /// The editor transform a layer has, including edits still rendering.
    public func transform(of layerId: String) -> LayerTransform {
        pendingTransforms["\(selectedSlideIndex):\(layerId)"] ?? layers.first { $0.layerId == layerId }?.transform ?? .identity
    }

    /// Image slots of the shown version, every slide.
    public var slots: [ImageSlot] { SlotScanner.slots(in: slides) }

    /// The slot a picture from Photos goes into: the current slide's empty slot, else any
    /// empty slot, else the current slide's slot, else the first.
    public var targetSlot: ImageSlot? {
        let usable = slots.filter { $0.layerId != nil }
        return usable.first { $0.slideIndex == selectedSlideIndex && $0.isEmpty }
            ?? usable.first(where: \.isEmpty)
            ?? usable.first { $0.slideIndex == selectedSlideIndex }
            ?? usable.first
    }

    public var composedCaption: String {
        CaptionParts(
            body: captionDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            hashtags: CaptionParts.parseHashtags(hashtagsDraft)
        ).caption
    }

    public var captionUsage: [CaptionLimits.Usage] {
        CaptionLimits.usage(caption: composedCaption, platforms: content.targetPlatforms)
    }

    public var hasCaptionChanges: Bool { composedCaption != content.caption }

    // MARK: - Loading & versions

    /// Load the version list and the current version, then measure layer boxes if needed.
    public func load() async {
        await refreshVersionList()
        if displayedVersion == nil || card.version == nil, let ref = content.currentVersion {
            if let version = try? await service.version(contentId: content.id, version: ref.version) {
                displayedVersion = displayedVersion ?? version
                if card.version == nil { card.version = version }
                onCardChange?(card)
            }
        }
        ensureLayouts()
        await loadChecks()
    }

    public func refreshVersionList() async {
        if let summaries = try? await service.versions(contentId: content.id) {
            versionSummaries = summaries.sorted { $0.version > $1.version }
        }
    }

    /// The posts list has a fresher card (plan item, schedule, job): take it, keep what is shown.
    public func replaceCard(_ fresh: PostCard) {
        guard fresh.id == card.id else { return }
        let wasCurrent = isViewingCurrentVersion
        let newer = fresh.content.currentVersion?.version != card.content.currentVersion?.version
        card = fresh
        if wasCurrent, newer || displayedVersion == nil, let version = fresh.version { displayedVersion = version }
        clampSlide()
    }

    /// A job for this post finished elsewhere (chat, AI image, the Mac): follow the current version.
    public func reloadContent() async {
        guard !activity.isBusy else { return }
        guard let fresh = try? await service.content(content.id) else { return }
        let wasCurrent = isViewingCurrentVersion
        card.content = fresh
        if wasCurrent, let ref = fresh.currentVersion, ref.version != displayedVersion?.version || card.version?.id != ref.id {
            await adopt(versionNumber: ref.version)
        } else {
            onCardChange?(card)
            await refreshVersionList()
        }
    }

    /// Show another version (read only unless it is the current one).
    public func selectVersion(_ versionNumber: Int) async {
        do {
            displayedVersion = try await service.version(contentId: content.id, version: versionNumber)
            clampSlide()
            if let selected = selectedLayerId, !layers.contains(where: { $0.layerId == selected }) { selectedLayerId = nil }
            error = nil
            ensureLayouts()
        } catch {
            self.error = Self.describe(error)
        }
    }

    public func showCurrentVersion() async {
        guard let current = content.currentVersion?.version else { return }
        if let version = card.version, version.version == current {
            displayedVersion = version
            clampSlide()
        } else {
            await selectVersion(current)
        }
    }

    public func selectSlide(_ index: Int) {
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
            async let loadedVersion = service.version(contentId: content.id, version: versionNumber)
            async let loadedContent = service.content(content.id)
            let version = try await loadedVersion
            let fresh = try await loadedContent
            card.content = fresh
            if version.version == fresh.currentVersion?.version { card.version = version }
            displayedVersion = version
            pendingTransforms = [:]
            previewBoxes = [:]
            clampSlide()
            if let selected = selectedLayerId, !layers.contains(where: { $0.layerId == selected }) { selectedLayerId = nil }
            let parts = CaptionParts(caption: fresh.caption)
            if !hasCaptionChanges || composedCaption == fresh.caption {
                captionDraft = parts.body
                hashtagsDraft = parts.hashtags.joined(separator: " ")
            }
            onCardChange?(card)
            await refreshVersionList()
        } catch {
            self.error = Self.describe(error)
        }
    }

    /// Versions rendered before layer boxes were stored get measured once (needs the Mac worker).
    public func ensureLayouts() {
        guard let version = activeVersion, isViewingCurrentVersion, content.type != .reel, !isCanvasVersion,
              version.slides.contains(where: { $0.layers == nil || $0.renderedAssetId == nil }),
              !measuredVersionIds.contains(version.id), activity == .idle, workerOnline()
        else { return }
        measuredVersionIds.insert(version.id)
        activity = .measuring
        let service = service
        let contentId = content.id
        let timeout = jobTimeout
        let interval = pollInterval
        Task {
            defer { if activity == .measuring { activity = .idle } }
            do {
                let job = try await service.render(contentId: contentId, ContentRenderRequest(version: version.version, format: .jpeg))
                _ = try await service.waitForJob(job.id, timeout: timeout, interval: interval)
                let measured = try await service.version(contentId: contentId, version: version.version)
                if displayedVersion?.id == measured.id { displayedVersion = measured }
                if card.version?.id == measured.id {
                    card.version = measured
                    onCardChange?(card)
                }
            } catch {
                // The editor still works from the layer list; boxes come with the next render.
            }
        }
    }

    // MARK: - Editing (design patches -> new version)

    public func setText(_ layerId: String, _ text: String) {
        guard canEdit else {
            error = editBlocker
            return
        }
        guard let layer = layers.first(where: { $0.layerId == layerId }), layer.text != text else { return }
        submit([DesignPatch(slide: selectedSlideIndex, .setText(layer: layerId, text: text))], name: "Metni değiştir")
    }

    public func setHidden(_ layerId: String, _ hidden: Bool) {
        guard canEdit else {
            error = editBlocker
            return
        }
        guard let layer = layers.first(where: { $0.layerId == layerId }), layer.isHidden != hidden else { return }
        submit([DesignPatch(slide: selectedSlideIndex, .setVisibility(layer: layerId, hidden: hidden))], name: hidden ? "Katmanı gizle" : "Katmanı göster")
    }

    /// Move a layer by `delta` artboard px.
    public func move(_ layerId: String, by delta: CGSize) {
        guard delta != .zero else { return }
        let current = transform(of: layerId)
        applyTransform(layerId, from: current, to: LayerTransformMath.moved(current, by: delta), name: "Taşı")
    }

    /// Resize a layer by `factor` with its top-left corner fixed.
    public func resize(_ layerId: String, factor: Double) {
        guard factor > 0, abs(factor - 1) > 0.001, let box = box(for: layerId) else { return }
        let current = transform(of: layerId)
        applyTransform(layerId, from: current, to: LayerTransformMath.resized(current, box: box, factor: factor), name: "Boyutlandır")
    }

    /// Restore the layer's original placement.
    public func resetTransform(_ layerId: String) {
        let current = transform(of: layerId)
        guard current != .identity else { return }
        applyTransform(layerId, from: current, to: .identity, name: "Konumu sıfırla")
    }

    /// Small steps (arrow pad), sent as one edit once they rest for `nudgeDebounce`.
    public func nudge(_ layerId: String, dx: CGFloat, dy: CGFloat) {
        guard canEdit else {
            error = editBlocker
            return
        }
        nudgeDelta.width += dx
        nudgeDelta.height += dy
        if let box = box(for: layerId) { previewBoxes[layerId] = box.offsetBy(dx: dx, dy: dy) }
        nudgeTask?.cancel()
        let wait = nudgeDebounce
        nudgeTask = Task { [weak self] in
            try? await Task.sleep(for: wait)
            guard !Task.isCancelled, let self else { return }
            self.flushNudge(layerId)
        }
    }

    /// Send a pending nudge now (e.g. the editor closes).
    public func flushNudge(_ layerId: String) {
        nudgeTask?.cancel()
        nudgeTask = nil
        let delta = nudgeDelta
        nudgeDelta = .zero
        guard delta != .zero else { return }
        previewBoxes[layerId] = nil
        move(layerId, by: delta)
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

    /// Upload a picture and put it into an image layer (replace) or a slot (fill).
    /// `slide` defaults to the current slide.
    public func placeImage(_ file: UploadFile, into layerId: String, slide: Int? = nil) {
        guard canEdit else {
            error = editBlocker
            return
        }
        let slideIndex = slide ?? selectedSlideIndex
        guard slides.indices.contains(slideIndex),
              let layer = SlideLayerScanner.layers(inHTML: slides[slideIndex].html, slideIndex: slideIndex).first(where: { $0.layerId == layerId })
        else {
            error = "Bu tasarımda “\(layerId)” katmanı yok."
            return
        }
        guard layer.kind == .slot || layer.kind == .image else {
            error = layer.kind == .logo ? "Logo marka kitinden gelir; buradan değiştirilemez." : "Bu katman bir görsel değil."
            return
        }
        guard !activity.changesVersion else {
            error = "Önceki değişiklik bitince yeniden dene."
            return
        }
        let service = service
        let brandId = content.brandId
        activity = .uploading(0)
        error = nil
        Task {
            do {
                let asset = try await service.uploadImage(file, brandId: brandId) { progress in
                    Task { @MainActor in
                        guard case .uploading = self.activity else { return }
                        self.activity = .uploading(progress)
                    }
                }
                onAssetUploaded?(asset, file)
                activity = .idle
                let src = DesignPatch.mediaSource(assetId: asset.id, mimeType: asset.mimeType)
                let op: DesignPatch.Operation = layer.kind == .slot ? .fillSlot(layer: layerId, src: src) : .replaceImage(layer: layerId, src: src)
                submit([DesignPatch(slide: slideIndex, op)], name: layer.kind == .slot ? "Yuvayı doldur" : "Görseli değiştir")
            } catch {
                activity = .idle
                self.error = Self.describe(error)
            }
        }
    }

    /// Fill the best slot (`targetSlot`) with a picture.
    public func fillSlot(with file: UploadFile) {
        guard let slot = targetSlot, let layerId = slot.layerId else {
            error = "Bu tasarımda görsel yuvası yok."
            return
        }
        placeImage(file, into: layerId, slide: slot.slideIndex)
    }

    public func clearSlot(_ layerId: String) {
        submit([DesignPatch(slide: selectedSlideIndex, .clearSlot(layer: layerId))], name: "Yuvayı boşalt")
    }

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
        let service = service
        let contentId = content.id
        let timeout = jobTimeout
        let interval = pollInterval
        editTask = Task {
            do {
                let job = try await service.render(contentId: contentId, ContentRenderRequest(version: base, patches: patches))
                let done = try await service.waitForJob(job.id, timeout: timeout, interval: interval) { job in
                    Task { @MainActor in
                        guard case .rendering = self.activity, let message = job.progressMessage, !message.isEmpty else { return }
                        self.activity = .rendering(message)
                    }
                }
                let output = ContentRenderOutput(done.output)
                if !output.unchanged, let number = output.version, number != base {
                    await adopt(versionNumber: number)
                    undoStack.append(EditStep(before: base, after: number, name: name))
                    redoStack = []
                } else {
                    previewBoxes = [:]
                    pendingTransforms = [:]
                }
            } catch {
                previewBoxes = [:]
                pendingTransforms = [:]
                self.error = "\(name): \(Self.describe(error))"
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

    /// Wait until the edits sent so far (and the queued ones) are done. For tests and scripts.
    public func waitUntilIdle(timeout: Duration = .seconds(300)) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while (activity.isBusy || nudgeTask != nil && nudgeDelta != .zero), clock.now < deadline {
            try? await Task.sleep(for: .milliseconds(20))
        }
    }

    // MARK: - Undo / redo (versions)

    public func undo() async {
        guard canUndo, let step = undoStack.popLast() else { return }
        if await restore(version: step.before) != nil {
            redoStack.append(step)
            notice = "Geri alındı: \(step.name)"
        } else {
            undoStack.append(step)
        }
    }

    public func redo() async {
        guard canRedo, let step = redoStack.popLast() else { return }
        if await restore(version: step.after) != nil {
            undoStack.append(step)
            notice = "Yinelendi: \(step.name)"
        } else {
            redoStack.append(step)
        }
    }

    /// "Bu sürümü geri yükle": add a copy of the shown version as the new current version.
    public func restoreDisplayedVersion() async {
        guard let shown = activeVersion?.version, let current = content.currentVersion?.version, shown != current else { return }
        if let restored = await restore(version: shown) {
            undoStack.append(EditStep(before: current, after: restored, name: "v\(shown) geri yükle"))
            redoStack = []
            notice = "v\(shown), v\(restored) olarak geri yüklendi."
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
            let restored = try await service.restoreVersion(contentId: content.id, version: version)
            await adopt(versionNumber: restored.version)
            error = nil
            return restored.version
        } catch {
            self.error = Self.describe(error)
            return nil
        }
    }

    // MARK: - "Neyi değiştireyim?" (AI revision)

    public func sendInstruction() async {
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
        // A canvas version's design is its Wecra document (S1): the request goes the Mac's way,
        // to the post's conversation, where the agent edits that document.
        if isCanvasVersion {
            await sendCanvasRequest(text, base: base)
            return
        }
        activity = .revising("İstek Mac'e gönderiliyor")
        error = nil
        let online = workerOnline
        do {
            let job = try await service.requestRevision(of: content, baseVersion: base, instructions: text)
            revisionJobId = job.id
            instruction = ""
            let done = try await service.waitForJob(job.id, timeout: revisionTimeout, interval: .seconds(1.5)) { [weak self] job in
                Task { @MainActor [weak self] in
                    guard let self, case .revising = self.activity else { return }
                    let message = job.status == .queued
                        ? (online() ? "Sırada" : "Mac'teki işçiyi bekliyor")
                        : (job.progressMessage ?? "AI düzenliyor")
                    self.activity = .revising(message)
                }
            }
            if let number = done.output?["version"]?.doubleValue.map({ Int($0) }), number != base {
                await adopt(versionNumber: number)
                undoStack.append(EditStep(before: base, after: number, name: "AI düzenlemesi"))
                redoStack = []
                notice = "AI düzenlemesi v\(number) olarak kaydedildi."
            } else {
                notice = "AI bu istekle bir değişiklik yapmadı."
            }
        } catch {
            self.error = "AI düzenlemesi: \(Self.describe(error))"
            if instruction.isEmpty { instruction = text }
        }
        revisionJobId = nil
        activity = .idle
    }

    /// "Neyi değiştireyim?" on a canvas version: the same message the Mac's post chat sends (the
    /// post's line with its current version and the canvas note, then the request) to the post's
    /// conversation; the agent's turn ends, and the version it made (if any) is adopted.
    private func sendCanvasRequest(_ text: String, base: Int) async {
        guard let chat else {
            error = CanvasOrigin.chatMissingNote
            return
        }
        activity = .revising("İstek sohbete gönderiliyor")
        error = nil
        let online = workerOnline
        let message = OutgoingMessage(text: CanvasOrigin.chatRequest(content: content, version: base, instruction: text))
        do {
            let result: UserMessageResult
            if let known = postConversations.conversationId(for: content.id) {
                do {
                    result = try await chat.send(message, to: known)
                } catch StudioAPIError.server(status: 404, code: _, message: _, issues: _) {
                    // The conversation was deleted: a new one.
                    result = try await chat.send(message, to: try await newPostConversation(chat))
                }
            } else {
                result = try await chat.send(message, to: try await newPostConversation(chat))
            }
            instruction = ""
            revisionRunId = result.run.id
            if let jobId = result.run.jobId {
                revisionJobId = jobId
                _ = try await service.waitForJob(jobId, timeout: revisionTimeout, interval: .seconds(1.5)) { [weak self] job in
                    Task { @MainActor [weak self] in
                        guard let self, case .revising = self.activity else { return }
                        let message = job.status == .queued
                            ? (online() ? "Sırada" : "Mac'teki işçiyi bekliyor")
                            : "AI tuvalde düzenliyor"
                        self.activity = .revising(message)
                    }
                }
            }
            let fresh = try await service.content(content.id)
            if let number = fresh.currentVersion?.version, number != base {
                await adopt(versionNumber: number)
                undoStack.append(EditStep(before: base, after: number, name: "AI düzenlemesi"))
                redoStack = []
                notice = "AI düzenlemesi v\(number) olarak kaydedildi."
            } else {
                notice = "AI bu istekle bir sürüm oluşturmadı; yanıtı post sohbetinde."
            }
        } catch {
            self.error = "AI düzenlemesi: \(Self.describe(error))"
            if instruction.isEmpty { instruction = text }
        }
        revisionJobId = nil
        revisionRunId = nil
        activity = .idle
    }

    private func newPostConversation(_ chat: any PostChatSender) async throws -> EntityID {
        let conversation = try await chat.createConversation(brandId: content.brandId, title: String(content.title.prefix(200)))
        postConversations.remember(conversation.id, for: content.id)
        return conversation.id
    }

    public func cancelRevision() async {
        if let runId = revisionRunId, let chat {
            _ = try? await chat.cancelRun(runId)
            return
        }
        guard let id = revisionJobId else { return }
        _ = try? await service.cancelJob(id)
    }

    // MARK: - Caption, approve, schedule

    /// Reset the drafts to the saved caption.
    public func resetCaptionDraft() {
        let parts = CaptionParts(caption: content.caption)
        captionDraft = parts.body
        hashtagsDraft = parts.hashtags.joined(separator: " ")
    }

    @discardableResult
    public func saveCaption() async -> Bool {
        let caption = composedCaption
        guard caption != content.caption else { return true }
        isSavingCaption = true
        defer { isSavingCaption = false }
        do {
            card.content = try await service.updateCaption(contentId: content.id, caption: caption)
            resetCaptionDraft()
            onCardChange?(card)
            error = nil
            notice = content.status.hasApproval ? "Açıklama kaydedildi." : "Açıklama kaydedildi; onay yeniden gerekiyor."
            return true
        } catch {
            self.error = Self.describe(error)
            return false
        }
    }

    /// The version whose checks the user chose to approve past ("Yine de onaylansın mı?" → yes,
    /// E7): an approval of that version — here, or the one scheduling makes — says so to the API.
    public private(set) var checksAcknowledgedVersion: Int?

    /// The user confirmed approving the current version although its checks hold it back.
    public func acknowledgeChecks() {
        checksAcknowledgedVersion = content.currentVersion?.version
    }

    /// Whether an approval now carries the user's acknowledgement of the checks.
    private var checksAcknowledged: Bool {
        checksAcknowledgedVersion != nil && checksAcknowledgedVersion == content.currentVersion?.version
    }

    /// Approve the current version. The API refuses while its checks hold the approval back
    /// unless the user confirmed first (`acknowledgeChecks()`, or `acknowledgingChecks`).
    @discardableResult
    public func approve(acknowledgingChecks: Bool = false) async -> Bool {
        guard canApprove, let hash = card.approvableHash else {
            error = approveBlocker
            return false
        }
        if acknowledgingChecks { acknowledgeChecks() }
        isApproving = true
        defer { isApproving = false }
        do {
            card.content = try await service.approve(contentId: content.id, hash: hash, acknowledgeChecks: checksAcknowledged)
            onCardChange?(card)
            error = nil
            notice = "Onaylandı."
            return true
        } catch {
            self.error = describeApproval(error)
            return false
        }
    }

    /// Accounts the post can go to (its brand's, enabled, of a target platform).
    public func schedulableAccounts(_ accounts: [SocialAccount]) -> [SocialAccount] {
        accounts.filter { $0.brandId == content.brandId && $0.status != .disabled && content.targetPlatforms.contains($0.platform) }
    }

    /// Default time: the active schedule, else the plan day at 09:00 (never within the next hour).
    public var defaultScheduleDate: Date {
        if let schedule = card.schedule { return schedule.scheduledAt }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        let base = card.planItem?.date.map { $0.date() } ?? Date().addingTimeInterval(86_400)
        var parts = calendar.dateComponents([.year, .month, .day], from: base)
        parts.hour = 9
        let date = calendar.date(from: parts) ?? base
        return max(date, Date().addingTimeInterval(3600))
    }

    /// Approve first when needed, then one schedule per account.
    @discardableResult
    public func schedule(at date: Date, accountIds: [EntityID]) async -> [Schedule] {
        guard !accountIds.isEmpty else {
            error = "Zamanlamak için en az bir hesap seç."
            return []
        }
        isScheduling = true
        defer { isScheduling = false }
        do {
            if !content.status.isSchedulable {
                guard let hash = card.approvableHash else {
                    error = "Zamanlamak için önce bu sürümün onaylanması gerekiyor."
                    return []
                }
                card.content = try await service.approve(contentId: content.id, hash: hash, acknowledgeChecks: checksAcknowledged)
                onCardChange?(card)
            }
            var created: [Schedule] = []
            for accountId in accountIds {
                created.append(try await service.createSchedule(ScheduleCreate(contentId: content.id, socialAccountId: accountId, scheduledAt: date)))
            }
            card.content = try await service.content(content.id)
            if let first = created.min(by: { $0.scheduledAt < $1.scheduledAt }) { card.schedule = first }
            onCardChange?(card)
            onSchedulesCreated?(created)
            error = nil
            notice = "Zamanlandı: \(TurkishFormat.dayAndTime(date))"
            return created
        } catch {
            self.error = describeApproval(error)
            return []
        }
    }

    /// An approval error; a refusal because of the checks also re-reads them.
    private func describeApproval(_ error: any Error) -> String {
        guard let refusal = ContentChecks.approvalRefusal(error) else { return Self.describe(error) }
        Task { await loadChecks() }
        return refusal
    }

    // MARK: - Production checks

    /// A `content.check` job of this post is running.
    public var runningCheckJob: Job? {
        activeJobs.values.filter { $0.type == .contentCheck }.max { $0.createdAt < $1.createdAt }
    }

    /// Checks are running for this post: a `content.check` job, or (while the shown version has
    /// no run yet) the generation or render that will store one.
    public var checksRunning: Bool {
        if runningCheckJob != nil { return true }
        guard checkRun == nil else { return false }
        return activity.changesVersion || activeJobs.values.contains { $0.type == .contentGenerate || $0.type == .contentRender }
    }

    /// Read the latest check run of the shown version.
    public func loadChecks() async {
        guard let version = activeVersion?.version else {
            checkRun = nil
            checkRunVersion = nil
            checksError = nil
            return
        }
        isLoadingChecks = true
        defer { isLoadingChecks = false }
        do {
            let run = try await service.latestCheckRun(contentId: content.id, version: version)
            guard activeVersion?.version == version else { return }
            checkRun = run
            checkRunVersion = version
            checksError = nil
        } catch is CancellationError {
            return
        } catch {
            guard activeVersion?.version == version else { return }
            if checkRunVersion != version {
                checkRun = nil
                checkRunVersion = nil
            }
            checksError = Self.describe(error)
        }
    }

    /// "Yeniden kontrol et": run the checks again on the shown version (`content.check`).
    public func runChecks() async {
        guard let version = activeVersion?.version else {
            error = "Henüz bir tasarım yok."
            return
        }
        guard runningCheckJob == nil, !isStartingChecks else { return }
        isStartingChecks = true
        defer { isStartingChecks = false }
        do {
            let job = try await service.runChecks(contentId: content.id, brandId: content.brandId, version: version)
            noteJob(job)
            if !job.status.isTerminal {
                let service = service
                Task { [weak self] in
                    let done = try? await service.waitForJob(job.id, timeout: .seconds(900), interval: .seconds(2))
                    guard let self else { return }
                    if let done { self.noteJob(done) } else if self.activeJobs[job.id] != nil {
                        self.activeJobs[job.id] = nil
                        await self.loadChecks()
                    }
                }
            }
        } catch {
            self.error = "Kontroller: \(Self.describe(error))"
        }
    }

    /// A job of this post changed (the live job feed): follow running checks and re-read the
    /// run when one that stores checks ends.
    public func noteJob(_ job: Job) {
        guard job.contentId == content.id, [.contentCheck, .contentGenerate, .contentRender].contains(job.type) else { return }
        if job.status.isTerminal {
            guard activeJobs.removeValue(forKey: job.id) != nil || job.type == .contentCheck else { return }
            checksReloadTask?.cancel()
            checksReloadTask = Task { [weak self] in await self?.loadChecks() }
        } else {
            activeJobs[job.id] = job
        }
    }

    /// What the checks say about approving the current version (re-read first).
    public func approvalGate() async -> ContentChecks.ApprovalGate {
        guard let version = content.currentVersion?.version else { return .clear }
        do {
            let run = try await service.latestCheckRun(contentId: content.id, version: version)
            if activeVersion?.version == version {
                checkRun = run
                checkRunVersion = version
                checksError = nil
            }
            let running = runningCheckJob != nil
                || (run == nil && (activity.changesVersion || activeJobs.values.contains { $0.type == .contentGenerate || $0.type == .contentRender }))
            return ContentChecks.gate(run: run, version: version, running: running)
        } catch {
            return .unavailable(Self.describe(error))
        }
    }

    // MARK: - Export

    /// Files of the shown version (JPEG/PNG per slide, PDF for all).
    public func export(_ format: PostExportFormat, slides: [Int]? = nil) async -> [ExportedFile] {
        guard let version = activeVersion else {
            error = "Dışa aktarılacak bir sürüm yok."
            return []
        }
        isExporting = true
        exportMessage = "\(format.label) hazırlanıyor"
        defer { isExporting = false }
        do {
            let exporter = PostExporter(service: service, timeout: jobTimeout, interval: pollInterval)
            let files = try await exporter.export(content: content, version: version, format: format, slides: slides) { [weak self] message in
                Task { @MainActor [weak self] in self?.exportMessage = message }
            }
            exportMessage = nil
            error = nil
            return files
        } catch {
            exportMessage = nil
            self.error = "Dışa aktarma: \(Self.describe(error))"
            return []
        }
    }
}
