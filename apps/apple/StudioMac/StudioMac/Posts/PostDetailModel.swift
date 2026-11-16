import AppKit
import StudioKit
import SwiftUI

/// An opened post (06): caption and hashtag editing, approve, schedule, AI edit request, slot image upload.
@MainActor
@Observable
final class PostDetailModel {
    unowned let app: AppModel
    private(set) var card: PostCard
    /// Where the card sat on screen (window coordinates), for the zoom transition.
    let sourceFrame: CGRect

    var captionDraft: String
    var hashtagsDraft: String
    var isEditingCaption = false
    var isSavingCaption = false
    var instruction = ""
    var isSendingInstruction = false
    var instructionSent: Job?
    var isApproving = false
    var error: String?

    // Schedule
    var schedulePresented = false
    var scheduleDate: Date
    var scheduleAccounts: Set<EntityID> = []
    var isScheduling = false

    // Slot image
    enum SlotUpload: Equatable {
        case none
        case uploading(Double)
        case uploaded(EntityID)
        case failed(String)
    }

    var slotUpload: SlotUpload = .none
    var slotImage: NSImage?
    private var lastImport: ImportedImage?

    init(app: AppModel, card: PostCard, sourceFrame: CGRect) {
        self.app = app
        self.card = card
        self.sourceFrame = sourceFrame
        let parts = CaptionParts(caption: card.content.caption)
        captionDraft = parts.body
        hashtagsDraft = parts.hashtags.joined(separator: " ")
        scheduleDate = Self.defaultScheduleDate(for: card)
        scheduleAccounts = Set(app.accounts(of: card.content.brandId).filter { $0.status != .disabled && card.content.targetPlatforms.contains($0.platform) }.map(\.id))
        if let pending = card.pendingImage, pending.forVersion == card.content.currentVersion?.version {
            slotUpload = .uploaded(pending.assetId)
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

    var typeText: String { TurkishFormat.typeLabel(content.type, slides: card.version?.slides ?? []) }

    var canApprove: Bool { card.approvableHash != nil && !isApproving }
    var approveHelp: String {
        if content.status.hasApproval { return "Bu post onaylandı." }
        if content.currentVersion == nil { return "Henüz bir sürüm yok." }
        if card.version == nil { return "Sürüm yükleniyor." }
        if card.approvableHash == nil { return "Gösterilen sürüm sunucudakiyle eşleşmiyor; yenile." }
        return "Bu sürümü onayla (⌘↩)"
    }

    var schedulableAccounts: [SocialAccount] {
        app.accounts(of: content.brandId).filter { $0.status != .disabled && content.targetPlatforms.contains($0.platform) }
    }

    // MARK: Actions

    func refresh(_ updated: Content) {
        card.content = updated
        app.posts.update(updated)
        if let fresh = app.posts.card(updated.id) { card = fresh }
    }

    func saveCaption() async {
        let caption = CaptionParts(body: captionDraft.trimmingCharacters(in: .whitespacesAndNewlines), hashtags: CaptionParts.parseHashtags(hashtagsDraft)).caption
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

    // MARK: Slot image

    func importSlotImage(urls: [URL]) {
        guard let url = urls.first else { return }
        do { uploadSlotImage(try ImageImport.from(url: url)) } catch { slotUpload = .failed(error.localizedDescription) }
    }

    func uploadSlotImage(_ image: ImportedImage) {
        lastImport = image
        slotImage = image.thumbnail
        slotUpload = .uploading(0)
        let service = app.dataService
        let brandId = content.brandId
        let contentId = content.id
        let version = content.currentVersion?.version
        Task {
            do {
                let asset = try await service.uploadImage(image.file, brandId: brandId) { progress in
                    Task { @MainActor in
                        if case .uploading = self.slotUpload { self.slotUpload = .uploading(progress) }
                    }
                }
                slotUpload = .uploaded(asset.id)
                app.images.seed(image.thumbnail, for: asset.id)
                app.pendingImages.save(PendingSlotImage(contentId: contentId, assetId: asset.id, forVersion: version, uploadedAt: .now))
                await app.posts.load()
                if let fresh = app.posts.card(contentId) { card = fresh }
            } catch {
                slotUpload = .failed(AppModel.describe(error))
            }
        }
    }

    func retrySlotUpload() {
        if let lastImport { uploadSlotImage(lastImport) }
    }
}
