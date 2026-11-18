import Foundation

// "Studio'ya gönder" (N20): what the share extension sends and what happens once the files are
// on the Mac. A share whose upload is still going when the sheet closes is written to the App
// Group; the system finishes the upload and wakes the app, which records the asset and does
// the rest (sends the chat message, fills the post's slot).

/// One share from the share sheet.
public struct PendingShare: Codable, Sendable, Equatable, Identifiable {
    public enum Destination: Codable, Sendable, Equatable {
        /// The brand's media only.
        case media
        /// A chat message with the files (`conversationId` nil = a new conversation).
        case conversation(id: EntityID?, message: String)
        /// The picture fills an empty image slot of a post (one picture).
        case slot(contentId: EntityID, version: Int, slide: Int, layerId: String)
    }

    public struct Item: Codable, Sendable, Equatable {
        /// The upload's tag (`share-<share id>-<index>`), kept on the background task.
        public var tag: String
        public var filename: String
        public var mimeType: String
        public var assetId: EntityID?
        public var failure: String?

        public init(tag: String, filename: String, mimeType: String, assetId: EntityID? = nil, failure: String? = nil) {
            self.tag = tag
            self.filename = filename
            self.mimeType = mimeType
            self.assetId = assetId
            self.failure = failure
        }

        public var isDone: Bool { assetId != nil || failure != nil }
    }

    public var id: String
    public var brandId: EntityID
    public var destination: Destination
    public var items: [Item]
    public var createdAt: Date
    public var deliveredAt: Date?
    /// Why the last step failed (shown by the app).
    public var failure: String?

    public init(id: String = UUID().uuidString.lowercased(), brandId: EntityID, destination: Destination, items: [Item] = [], createdAt: Date = Date()) {
        self.id = id
        self.brandId = brandId
        self.destination = destination
        self.items = items
        self.createdAt = createdAt
    }

    public static func tag(shareId: String, index: Int) -> String { "share-\(shareId)-\(index)" }

    /// The share id and file index of a tag (nil for other uploads).
    public static func parse(tag: String) -> (shareId: String, index: Int)? {
        guard tag.hasPrefix("share-"), let dash = tag.lastIndex(of: "-"), let index = Int(tag[tag.index(after: dash)...]) else { return nil }
        let id = tag[tag.index(tag.startIndex, offsetBy: 6)..<dash]
        guard !id.isEmpty else { return nil }
        return (String(id), index)
    }

    public var isUploaded: Bool { !items.isEmpty && items.allSatisfy(\.isDone) }
    public var uploadedAssetIds: [EntityID] { items.compactMap(\.assetId) }
    public var failedCount: Int { items.filter { $0.failure != nil }.count }

    /// Record one finished upload (by tag).
    public mutating func record(tag: String, assetId: EntityID?, failure: String?) {
        guard let index = items.firstIndex(where: { $0.tag == tag }) else { return }
        items[index].assetId = assetId
        items[index].failure = assetId == nil ? (failure ?? "Yüklenemedi.") : nil
    }
}

/// Shares still on their way, one JSON file each, in the App Group's `Shares` folder.
public struct ShareInbox: Sendable {
    public let directory: URL

    public init(directory: URL) {
        self.directory = directory
    }

    /// nil without the App Group (the extension then uploads only while its sheet is open).
    public static func standard(container: StudioSharedContainer = .current) -> ShareInbox? {
        container.directory("Shares").map(ShareInbox.init(directory:))
    }

    /// Where the upload bodies of shares are written (deleted once their upload ended).
    public var uploadsDirectory: URL { directory.appendingPathComponent("Uploads", isDirectory: true) }

    private func url(_ id: String) -> URL {
        let safe = id.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) || $0 == "-" ? Character($0) : "_" }
        return directory.appendingPathComponent("\(String(safe)).json")
    }

    public func save(_ share: PendingShare) throws {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try StudioJSON.encoder().encode(share).write(to: url(share.id), options: .atomic)
    }

    public func load(_ id: String) -> PendingShare? {
        guard let data = try? Data(contentsOf: url(id)) else { return nil }
        return try? StudioJSON.decoder().decode(PendingShare.self, from: data)
    }

    /// Oldest first.
    public func all() -> [PendingShare] {
        let names = (try? FileManager.default.contentsOfDirectory(atPath: directory.path)) ?? []
        return names.filter { $0.hasSuffix(".json") }
            .compactMap { name in
                (try? Data(contentsOf: directory.appendingPathComponent(name))).flatMap { try? StudioJSON.decoder().decode(PendingShare.self, from: $0) }
            }
            .sorted { $0.createdAt < $1.createdAt }
    }

    public func remove(_ id: String) {
        try? FileManager.default.removeItem(at: url(id))
    }

    /// An upload of a share finished (in this process or after the extension was gone): record
    /// its asset, delete its body file. Returns the updated share (nil for other uploads).
    @discardableResult
    public func record(_ upload: FinishedBackgroundUpload) -> PendingShare? {
        try? FileManager.default.removeItem(at: uploadsDirectory.appendingPathComponent(APIClient.bodyFileName(forTag: upload.tag)))
        guard let (shareId, _) = PendingShare.parse(tag: upload.tag), var share = load(shareId) else { return nil }
        let asset = upload.asset
        share.record(tag: upload.tag, assetId: asset?.id, failure: asset == nil ? upload.failure : nil)
        try? save(share)
        return share
    }

    /// Shares that are uploaded but not delivered yet.
    public func readyToDeliver() -> [PendingShare] {
        all().filter { $0.isUploaded && $0.deliveredAt == nil }
    }

    /// Forget delivered shares and ones older than `maxAge` (an upload the system never
    /// finished); their body files go too.
    public func prune(now: Date = Date(), maxAge: TimeInterval = 2 * 24 * 3600) {
        for share in all() where share.deliveredAt != nil || now.timeIntervalSince(share.createdAt) > maxAge {
            for item in share.items {
                try? FileManager.default.removeItem(at: uploadsDirectory.appendingPathComponent(APIClient.bodyFileName(forTag: item.tag)))
            }
            remove(share.id)
        }
    }
}

/// What happens once a share's files are on the Mac.
public enum ShareDelivery {
    public enum Step: Sendable, Equatable {
        /// Media only: nothing more.
        case none
        /// Send a chat message with the files (a new conversation when `conversationId` is nil).
        case message(conversationId: EntityID?, text: String, assetIds: [EntityID], clientMessageId: String)
        /// Fill the post's slot with the picture (a design edit rendered by the Mac).
        case fillSlot(contentId: EntityID, version: Int, slide: Int, layerId: String, assetId: EntityID, mimeType: String)
        /// Nothing arrived; the reason.
        case failed(String)
    }

    /// Pure: the step for an uploaded share (tested).
    public static func step(for share: PendingShare) -> Step {
        let uploaded = share.items.filter { $0.assetId != nil }
        if uploaded.isEmpty {
            return .failed(share.items.compactMap(\.failure).first ?? "Dosyalar Mac'e ulaşmadı.")
        }
        switch share.destination {
        case .media:
            return .none
        case .conversation(let id, let message):
            return .message(
                conversationId: id, text: message.trimmingCharacters(in: .whitespacesAndNewlines),
                assetIds: uploaded.compactMap(\.assetId), clientMessageId: "share-\(share.id)")
        case .slot(let contentId, let version, let slide, let layerId):
            let first = uploaded[0]
            return .fillSlot(contentId: contentId, version: version, slide: slide, layerId: layerId, assetId: first.assetId!, mimeType: first.mimeType)
        }
    }

    /// Where the delivered share can be seen.
    public enum Result: Sendable, Equatable {
        case media
        case conversation(EntityID)
        case post(EntityID, jobId: EntityID)
    }

    /// Do the step with `client`. Safe to repeat for a message (the server answers a repeated
    /// `clientMessageId` with the first message).
    public static func deliver(_ share: PendingShare, client: APIClient) async throws -> Result {
        switch step(for: share) {
        case .none:
            return .media
        case .failed(let reason):
            throw StudioAPIError.invalidConfiguration(reason)
        case .message(let conversationId, let text, let assetIds, let clientMessageId):
            let id: EntityID
            if let conversationId {
                id = conversationId
            } else {
                id = try await client.createConversation(ConversationCreate(brandId: share.brandId, title: conversationTitle(text: text, count: assetIds.count))).id
            }
            let message = OutgoingMessage(text: text, attachments: assetIds.map { OutgoingAttachment(assetId: $0, alias: nil) }, clientMessageId: clientMessageId)
            _ = try await client.sendMessage(conversationId: id, MessageWire.body(for: message))
            return .conversation(id)
        case .fillSlot(let contentId, let version, let slide, let layerId, let assetId, let mimeType):
            let patch = DesignPatch(slide: slide, .fillSlot(layer: layerId, src: DesignPatch.mediaSource(assetId: assetId, mimeType: mimeType)))
            let job = try await client.renderContent(contentId: contentId, ContentRenderRequest(version: version, patches: [patch], note: "Paylaşımdan görsel"))
            return .post(contentId, jobId: job.id)
        }
    }

    /// A new conversation's title: the message's first line, else what was shared.
    public static func conversationTitle(text: String, count: Int) -> String {
        if let line = text.split(whereSeparator: \.isNewline).first, !line.trimmingCharacters(in: .whitespaces).isEmpty {
            return String(line.trimmingCharacters(in: .whitespaces).prefix(80))
        }
        return count == 1 ? "Paylaşılan dosya" : "Paylaşılan \(count) dosya"
    }
}

/// Posts of a brand whose current version has an empty image slot the phone may fill (an HTML
/// design, not a canvas render or a Reels, not being published).
public struct SlotTarget: Sendable, Equatable, Identifiable {
    public var contentId: EntityID
    public var title: String
    public var version: Int
    public var slot: ImageSlot
    public var thumbnailAssetId: EntityID?

    public var id: String { "\(contentId)|\(slot.slideIndex)|\(slot.layerId ?? "")" }

    public init(contentId: EntityID, title: String, version: Int, slot: ImageSlot, thumbnailAssetId: EntityID?) {
        self.contentId = contentId
        self.title = title
        self.version = version
        self.slot = slot
        self.thumbnailAssetId = thumbnailAssetId
    }

    /// The fillable empty slots of `content` at `version` (pure; tested).
    public static func targets(content: Content, version: ContentVersion) -> [SlotTarget] {
        guard content.deletedAt == nil, content.type != .reel, !content.status.isLocked,
              content.currentVersion?.version == version.version, !version.isCanvasVersion else { return [] }
        let thumbnail = version.slides.lazy.compactMap(\.renderedAssetId).first
        return SlotScanner.slots(in: version.slides)
            .filter { $0.isEmpty && $0.layerId != nil }
            .map { SlotTarget(contentId: content.id, title: WidgetSnapshot.displayTitle(content.title), version: version.version, slot: $0, thumbnailAssetId: thumbnail) }
    }

    /// "2. kare · Ürün görseli (4:5)".
    public var slotLabel: String {
        var text = "\(slot.slideIndex + 1). kare"
        if let label = slot.label?.trimmingCharacters(in: .whitespaces), !label.isEmpty { text += " · \(label)" }
        if let ratio = slot.ratio { text += " (\(ratio))" }
        return text
    }
}
