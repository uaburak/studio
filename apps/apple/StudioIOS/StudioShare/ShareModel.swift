import AVFoundation
import StudioKit
import UIKit
import UniformTypeIdentifiers

/// "Studio'ya gönder" (N20): the shared pictures and videos, the brand, where they go, and the
/// sending. Big uploads go to a background session in the App Group (when the build has one),
/// so the sheet may close before they end; the app finishes the share then (`ShareInbox`).
@MainActor
final class ShareModel {
    enum Kind { case image, video }

    struct Item: Identifiable {
        let id = UUID()
        var kind: Kind
        var filename: String
        /// The local copy (a video, or the picture's file before it is prepared).
        var source: URL?
        /// A prepared picture, written to disk for the upload.
        var prepared: UploadFile?
        var thumbnail: UIImage?
        var durationMs: Int?
        /// Why it cannot be sent (the others still go).
        var error: String?
    }

    enum Destination: Equatable { case media, chat, slot }

    enum Connection: Equatable {
        case connecting
        case connected(String)
        case failed(String)
    }

    enum Phase: Equatable {
        case editing
        case working(String, Double?)
        case done(String)
        case failed(String)
    }

    private(set) var items: [Item] = []
    private(set) var isLoadingItems = true
    private(set) var brands: [SharedBrand] = []
    var brandId: EntityID? {
        didSet {
            guard brandId != oldValue else { return }
            conversations = []
            conversationId = nil
            slotTargets = []
            slotTarget = nil
            if destination != .media { Task { await loadDestinationOptions() } }
        }
    }
    var destination: Destination = .media {
        didSet { if destination != oldValue { Task { await loadDestinationOptions() } } }
    }
    private(set) var conversations: [Conversation] = []
    private(set) var isLoadingOptions = false
    /// nil = a new conversation.
    var conversationId: EntityID?
    var message = ""
    private(set) var slotTargets: [SlotTarget] = []
    var slotTarget: SlotTarget?
    private(set) var connection: Connection = .connecting
    private(set) var phase: Phase = .editing
    /// Every upload is in the system's hands: the sheet may close.
    private(set) var canContinueInBackground = false

    var onChange: (() -> Void)?

    private let container = StudioSharedContainer.current
    private let inbox = ShareInbox.standard()
    private let workDirectory: URL
    private var client: APIClient?
    private var thumbnailLoader: (@Sendable (EntityID) async -> Data?)?

    init() {
        workDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("studio-share-\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
        if let defaults = container.sharedDefaults {
            brands = SharedBrand.load(from: defaults)
            let last = defaults.string(forKey: SharedSettingsKeys.lastBrand)
            brandId = brands.contains { $0.id == last } ? last : brands.first?.id
        }
    }

    deinit {
        try? FileManager.default.removeItem(at: workDirectory)
    }

    private func changed() { onChange?() }

    // MARK: Derived

    var sendableItems: [Item] { items.filter { $0.error == nil && ($0.prepared != nil || $0.source != nil) } }
    var imageCount: Int { sendableItems.filter { $0.kind == .image }.count }
    var videoCount: Int { sendableItems.filter { $0.kind == .video }.count }
    var brandName: String? { brands.first { $0.id == brandId }?.name }
    /// A slot takes exactly one picture.
    var canUseSlot: Bool { imageCount == 1 && videoCount == 0 }
    /// Uploads go on after the sheet closes (App Group available).
    var usesBackgroundUploads: Bool { inbox != nil }

    var isConnected: Bool { if case .connected = connection { true } else { false } }
    var isWorking: Bool { if case .working = phase { true } else { false } }

    /// Why "Gönder" is off (nil: it can be sent).
    var sendBlocker: String? {
        if isLoadingItems { return "Dosyalar okunuyor…" }
        if sendableItems.isEmpty { return items.isEmpty ? "Paylaşılan görsel ya da video yok." : "Gönderilebilecek dosya yok." }
        if !isConnected { return "Mac'e bağlanınca gönderebilirsin." }
        if brandId == nil { return "Bir marka seç." }
        if destination == .slot {
            if !canUseSlot { return "Görsel yuvasına tek bir fotoğraf konur." }
            if slotTarget == nil { return "Bir post ve görsel yuvası seç." }
        }
        return nil
    }

    var canSend: Bool {
        guard sendBlocker == nil else { return false }
        switch phase {
        case .editing, .failed: return true
        case .working, .done: return false
        }
    }

    // MARK: Loading

    func start(with context: NSExtensionContext?) {
        Task { await connect() }
        Task { await loadItems(context) }
    }

    private func connect() async {
        connection = .connecting
        changed()
        let store = SharedDeviceTokenStore.standard(container: container)
        let manual = container.sharedDefaults.flatMap { SharedSettingsKeys.manualRemoteURL(in: $0) }
        do {
            let found = try await PairedMac.connect(store: store, manual: manual)
            let client = found.client
            if usesBackgroundUploads {
                let transport = BackgroundUploadTransport(identifier: container.shareUploadSessionId, sharedContainerIdentifier: container.appGroupId)
                // Uploads an earlier share left running finish here: record them for the app.
                let inbox = inbox
                transport.onFinishedElsewhere { upload in _ = inbox?.record(upload) }
                client.useUploads(transport: StartReportingTransport(base: transport) { [weak self] tag in
                    Task { @MainActor in self?.uploadStarted(tag) }
                }, retry: UploadRetryPolicy(maxAttempts: 2, initialDelay: .seconds(2)))
            }
            self.client = client
            thumbnailLoader = { id in try? await client.assetThumbnailData(id, width: 160) }
            connection = .connected(found.credential.routes?.macName ?? found.credential.serverName)
            changed()
            await loadBrands()
        } catch {
            connection = .failed(error.message)
            changed()
        }
    }

    func retryConnection() {
        guard !isConnected else { return }
        Task { await connect() }
    }

    private func loadBrands() async {
        guard let client else { return }
        guard let loaded = try? await client.brands() else { return }
        brands = loaded.map { SharedBrand(id: $0.id, name: $0.name) }
        if let defaults = container.sharedDefaults { SharedBrand.save(brands, to: defaults) }
        if brandId == nil || !brands.contains(where: { $0.id == brandId }) { brandId = brands.first?.id }
        changed()
    }

    func loadDestinationOptions() async {
        guard let client, let brandId else { return }
        isLoadingOptions = true
        changed()
        defer {
            isLoadingOptions = false
            changed()
        }
        switch destination {
        case .media:
            return
        case .chat:
            let loaded = (try? await client.conversations(brandId: brandId)) ?? []
            guard brandId == self.brandId else { return }
            conversations = Array(loaded.prefix(30))
        case .slot:
            let contents = ((try? await client.contents(brandId: brandId)) ?? [])
                .filter { $0.currentVersion != nil && $0.type != .reel && !$0.status.isLocked && $0.deletedAt == nil }
                .sorted { $0.updatedAt > $1.updatedAt }
                .prefix(15)
            var found: [SlotTarget] = []
            await withTaskGroup(of: [SlotTarget].self) { group in
                for content in contents {
                    group.addTask {
                        guard let ref = content.currentVersion,
                              let version = try? await client.contentVersion(contentId: content.id, version: ref.version) else { return [] }
                        return SlotTarget.targets(content: content, version: version)
                    }
                }
                for await targets in group { found += targets }
            }
            guard brandId == self.brandId else { return }
            let order = Dictionary(uniqueKeysWithValues: contents.enumerated().map { ($1.id, $0) })
            slotTargets = found.sorted { (order[$0.contentId] ?? 0, $0.slot.slideIndex) < (order[$1.contentId] ?? 0, $1.slot.slideIndex) }
            if let current = slotTarget, !slotTargets.contains(current) { slotTarget = nil }
        }
    }

    func thumbnail(for assetId: EntityID) async -> UIImage? {
        guard let loader = thumbnailLoader, let data = await loader(assetId) else { return nil }
        return UIImage(data: data)
    }

    // MARK: Reading the shared items

    private func loadItems(_ context: NSExtensionContext?) async {
        let providers = (context?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
        for (index, provider) in providers.prefix(10).enumerated() {
            if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                items.append(await loadVideo(provider, index: index))
            } else if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                items.append(await loadImage(provider, index: index))
            }
            changed()
        }
        isLoadingItems = false
        changed()
    }

    private func loadImage(_ provider: NSItemProvider, index: Int) async -> Item {
        let fallbackName = "gorsel-\(index + 1)"
        var item = Item(kind: .image, filename: provider.suggestedName ?? fallbackName)
        do {
            let file = try await copyFile(provider, type: .image, name: "image-\(index)")
            let prepared = try ImagePreparation.prepare(fileAt: file, filename: provider.suggestedName ?? file.lastPathComponent)
            try? FileManager.default.removeItem(at: file)
            item.prepared = try writePrepared(prepared.file, index: index)
            item.filename = prepared.file.filename
            item.thumbnail = prepared.thumbnail.map { UIImage(cgImage: $0) }
        } catch let error as StudioAPIError {
            item.error = error.localizedDescription
        } catch {
            // Some apps hand over only an image object (a screenshot being edited).
            if let image = await loadUIImage(provider), let data = image.pngData(),
               let prepared = try? ImagePreparation.prepare(data: data, filename: provider.suggestedName ?? fallbackName),
               let written = try? writePrepared(prepared.file, index: index) {
                item.prepared = written
                item.filename = prepared.file.filename
                item.thumbnail = prepared.thumbnail.map { UIImage(cgImage: $0) }
            } else {
                item.error = "Görsel okunamadı. Asıl dosya iCloud'da olabilir; yeniden dene."
            }
        }
        return item
    }

    private func loadVideo(_ provider: NSItemProvider, index: Int) async -> Item {
        var item = Item(kind: .video, filename: provider.suggestedName ?? "video-\(index + 1)")
        do {
            let file = try await copyFile(provider, type: .movie, name: "video-\(index)")
            item.source = file
            item.filename = file.lastPathComponent
            let info = try await VideoPreparation.inspect(file)
            item.durationMs = info.durationMs
            if case .refuse(let reason) = VideoUploadPlanner.decide(info) { item.error = reason }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: file))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 240, height: 240)
            if let (image, _) = try? await generator.image(at: .zero) { item.thumbnail = UIImage(cgImage: image) }
        } catch let error as StudioAPIError {
            item.error = error.localizedDescription
        } catch {
            item.error = "Video okunamadı. Asıl dosya iCloud'da olabilir; yeniden dene."
        }
        return item
    }

    /// The provider's file, copied into the work folder (its own copy disappears after the callback).
    private func copyFile(_ provider: NSItemProvider, type: UTType, name: String) async throws -> URL {
        let folder = workDirectory
        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(for: type, openInPlace: false) { url, _, error in
                guard let url else {
                    continuation.resume(throwing: error ?? CocoaError(.fileReadUnknown))
                    return
                }
                let ext = url.pathExtension.isEmpty ? (type.preferredFilenameExtension ?? "dat") : url.pathExtension
                let target = folder.appendingPathComponent("\(name).\(ext)")
                do {
                    try? FileManager.default.removeItem(at: target)
                    try FileManager.default.copyItem(at: url, to: target)
                    continuation.resume(returning: target)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    private func loadUIImage(_ provider: NSItemProvider) async -> UIImage? {
        guard provider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            _ = provider.loadObject(ofClass: UIImage.self) { object, _ in
                continuation.resume(returning: object as? UIImage)
            }
        }
    }

    /// Background uploads read from files: the prepared picture goes to disk.
    private func writePrepared(_ file: UploadFile, index: Int) throws -> UploadFile {
        let url = workDirectory.appendingPathComponent("prepared-\(index)-\(file.filename)")
        try file.data.write(to: url, options: .atomic)
        return UploadFile(filename: file.filename, mimeType: file.mimeType, fileURL: url, width: file.width, height: file.height)
    }

    // MARK: Sending

    private var startedTags: Set<String> = []
    private var expectedTags: Set<String> = []

    private func uploadStarted(_ tag: String?) {
        guard let tag else { return }
        startedTags.insert(tag)
        let ready = usesBackgroundUploads && !expectedTags.isEmpty && expectedTags.isSubset(of: startedTags)
        if ready != canContinueInBackground {
            canContinueInBackground = ready
            changed()
        }
    }

    private func set(_ phase: Phase) {
        self.phase = phase
        changed()
    }

    func send() async {
        guard canSend, let client, let brandId else { return }
        if let defaults = container.sharedDefaults { defaults.set(brandId, forKey: SharedSettingsKeys.lastBrand) }
        let toSend = sendableItems

        // 1. Videos that do not fit are exported again (the sheet must stay open for this).
        var files: [UploadFile] = []
        for (index, item) in toSend.enumerated() {
            if let prepared = item.prepared {
                files.append(prepared)
                continue
            }
            guard let source = item.source else { continue }
            let label = toSend.count > 1 ? "Video hazırlanıyor (\(index + 1)/\(toSend.count))" : "Video hazırlanıyor"
            set(.working(label, 0))
            do {
                let prepared = try await VideoPreparation.prepare(source, workDirectory: workDirectory, filename: item.filename) { [weak self] progress in
                    Task { @MainActor in self?.set(.working(label, progress)) }
                }
                files.append(prepared.file)
            } catch {
                set(.failed(StudioAPIError.from(error).localizedDescription))
                return
            }
        }

        // 2. The share, written down so the app can finish it if the sheet closes.
        let destination: PendingShare.Destination
        switch self.destination {
        case .media: destination = .media
        case .chat: destination = .conversation(id: conversationId, message: message)
        case .slot:
            guard let target = slotTarget, let layerId = target.slot.layerId else { return }
            destination = .slot(contentId: target.contentId, version: target.version, slide: target.slot.slideIndex, layerId: layerId)
        }
        let shareId = UUID().uuidString.lowercased()
        var share = PendingShare(id: shareId, brandId: brandId, destination: destination, items: files.enumerated().map { index, file in
            PendingShare.Item(tag: PendingShare.tag(shareId: shareId, index: index), filename: file.filename, mimeType: file.mimeType)
        })
        try? inbox?.save(share)
        expectedTags = Set(share.items.map(\.tag))
        startedTags = []

        // 3. Every upload at once (the background session takes them all).
        let total = Double(max(1, files.reduce(0) { $0 + max(1, $1.byteCount) }))
        uploadFractions = Array(repeating: 0, count: files.count)
        set(.working(files.count == 1 ? "Yükleniyor" : "\(files.count) dosya yükleniyor", 0))
        let bodyDirectory = inbox?.uploadsDirectory
        await withTaskGroup(of: (Int, Asset?, String?).self) { group in
            for (index, file) in files.enumerated() {
                let tag = share.items[index].tag
                let weight = Double(max(1, file.byteCount)) / total
                group.addTask {
                    do {
                        let asset = try await client.uploadAsset(file, brandId: brandId, kind: file.assetKind, tag: tag, bodyDirectory: bodyDirectory) { value in
                            Task { @MainActor in self.uploadProgress(index: index, value: value * weight) }
                        }
                        return (index, asset, nil)
                    } catch {
                        return (index, nil, error.localizedDescription)
                    }
                }
            }
            for await (index, asset, failure) in group {
                share.record(tag: share.items[index].tag, assetId: asset?.id, failure: failure)
                try? inbox?.save(share)
            }
        }
        canContinueInBackground = false

        // 4. The message or the slot.
        set(.working("Mac'e iletiliyor", nil))
        do {
            let result = try await ShareDelivery.deliver(share, client: client)
            share.deliveredAt = Date()
            inbox?.remove(share.id)
            set(.done(Self.doneText(result, sent: share.uploadedAssetIds.count, failed: share.failedCount, brand: brandName)))
        } catch {
            inbox?.remove(share.id)
            set(.failed(StudioAPIError.from(error).localizedDescription))
        }
    }

    private var uploadFractions: [Double] = []

    private func uploadProgress(index: Int, value: Double) {
        guard case .working(let label, _) = phase, uploadFractions.indices.contains(index) else { return }
        uploadFractions[index] = value
        phase = .working(label, min(0.99, uploadFractions.reduce(0, +)))
        changed()
    }

    static func doneText(_ result: ShareDelivery.Result, sent: Int, failed: Int, brand: String?) -> String {
        let what = sent == 1 ? "Dosya" : "\(sent) dosya"
        var text: String
        switch result {
        case .media: text = "\(what) \(brand.map { "\($0) medyasına" } ?? "medyaya") yüklendi."
        case .conversation: text = "\(what) sohbete gönderildi."
        case .post: text = "Görsel posta konuyor; Mac yeni sürümü hazırlıyor."
        }
        if failed > 0 { text += " \(failed) dosya yüklenemedi." }
        return text
    }
}

/// Reports when an upload is handed to the system (all of them handed: the sheet may close).
final class StartReportingTransport: UploadTransport, @unchecked Sendable {
    let base: any UploadTransport
    let onStart: @Sendable (String?) -> Void

    init(base: any UploadTransport, onStart: @escaping @Sendable (String?) -> Void) {
        self.base = base
        self.onStart = onStart
    }

    func upload(_ request: URLRequest, body: Data, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        onStart(nil)
        return try await base.upload(request, body: body, progress: progress)
    }

    func upload(_ request: URLRequest, bodyFile: URL, tag: String?, progress: (@Sendable (Double) -> Void)?) async throws -> (Data, URLResponse) {
        onStart(tag)
        return try await base.upload(request, bodyFile: bodyFile, tag: tag, progress: progress)
    }
}
