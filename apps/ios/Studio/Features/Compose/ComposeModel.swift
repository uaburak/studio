import Observation
import UIKit

/// Compose screen state machine:
///
///     editing ──submit──► submitting ──► submitted(content, job)
///                              │      └─► jobFailed(content, error) ──retryJob──► submitted
///                              └────────► failed(error) ──(edit)──► editing
///
/// Submitting creates the content (`POST /api/contents`), then a
/// `content.generate` job for it (`POST /api/jobs`). If the second call fails
/// the content already exists, so only the job is retried.
@MainActor
@Observable
final class ComposeModel {
    enum Phase: Equatable {
        case editing
        case submitting
        case submitted(content: Content, job: Job)
        case jobFailed(content: Content, error: APIError)
        case failed(APIError)
    }

    struct Attachment: Identifiable, Equatable {
        enum State: Equatable {
            case preparing
            case uploading(Double)
            case uploaded(Asset)
            case failed(String)
        }

        let id = UUID()
        var isVideo: Bool
        var thumbnail: UIImage?
        var file: UploadFile?
        var state: State

        static func == (lhs: Attachment, rhs: Attachment) -> Bool {
            lhs.id == rhs.id && lhs.state == rhs.state && lhs.isVideo == rhs.isVideo
        }
    }

    var title = ""
    var brief = ""
    var type: ContentType = .post
    var platforms: Set<Platform> = [.instagram]
    private(set) var attachments: [Attachment] = []
    private(set) var phase: Phase = .editing

    @ObservationIgnored private var uploads: [UUID: Task<Void, Never>] = [:]

    static let maxTitleLength = 200
    static let maxBriefLength = 20_000

    // MARK: Validation

    var trimmedBrief: String { brief.trimmingCharacters(in: .whitespacesAndNewlines) }

    /// Title sent to the API: the typed one, else the brief's first line (≤ 60 characters).
    var resolvedTitle: String {
        let typed = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !typed.isEmpty { return String(typed.prefix(Self.maxTitleLength)) }
        let firstLine = trimmedBrief.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
        guard firstLine.count > 60 else { return firstLine }
        let cut = firstLine.prefix(60)
        let words = cut.split(separator: " ").dropLast()
        return (words.isEmpty ? String(cut) : words.joined(separator: " ")) + "…"
    }

    var isUploading: Bool {
        attachments.contains {
            if case .uploading = $0.state { return true }
            return $0.state == .preparing
        }
    }

    /// Why submit is disabled; nil when the form is ready.
    var validationMessage: String? {
        if trimmedBrief.isEmpty { return "Brif yazın." }
        if brief.count > Self.maxBriefLength { return "Brif en fazla 20.000 karakter olabilir." }
        if platforms.isEmpty { return "En az bir platform seçin." }
        if isUploading { return "Ekler yükleniyor…" }
        if attachments.contains(where: { if case .failed = $0.state { true } else { false } }) {
            return "Yüklenemeyen ekleri kaldırın ya da yeniden deneyin."
        }
        return nil
    }

    var canSubmit: Bool { validationMessage == nil && phase != .submitting }

    var uploadedAssetIds: [String] {
        attachments.compactMap { if case .uploaded(let asset) = $0.state { asset.id } else { nil } }
    }

    // MARK: Submit

    func submit(api: APIClient, brandId: String) async {
        guard canSubmit else { return }
        phase = .submitting
        let body = ContentCreate(
            brandId: brandId, type: type, title: resolvedTitle, brief: trimmedBrief,
            targetPlatforms: Platform.knownCases.filter { platforms.contains($0) }, caption: nil)
        let content: Content
        do {
            content = try await api.createContent(body)
        } catch {
            phase = .failed(error)
            return
        }
        await createJob(api: api, content: content)
    }

    func retryJob(api: APIClient) async {
        guard case .jobFailed(let content, _) = phase else { return }
        phase = .submitting
        await createJob(api: api, content: content)
    }

    private func createJob(api: APIClient, content: Content) async {
        let job = JobCreate(
            type: .contentGenerate, payload: GeneratePayload.make(for: content, assetIds: uploadedAssetIds),
            brandId: content.brandId, contentId: content.id)
        do {
            phase = .submitted(content: content, job: try await api.createJob(job))
        } catch {
            phase = .jobFailed(content: content, error: error)
        }
    }

    /// Back to editing after an error, keeping what was typed.
    func dismissError() {
        if case .failed = phase { phase = .editing }
    }

    /// Clear the form for the next brief.
    func reset() {
        uploads.values.forEach { $0.cancel() }
        uploads = [:]
        title = ""
        brief = ""
        type = .post
        platforms = [.instagram]
        attachments = []
        phase = .editing
    }

    // MARK: Attachments

    func addPlaceholder(isVideo: Bool) -> UUID {
        let attachment = Attachment(isVideo: isVideo, state: .preparing)
        attachments.append(attachment)
        return attachment.id
    }

    func prepared(_ id: UUID, _ imported: MediaImport.Imported, api: APIClient, brandId: String) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        attachments[index].file = imported.file
        attachments[index].thumbnail = imported.thumbnail
        attachments[index].isVideo = imported.isVideo
        startUpload(id, api: api, brandId: brandId)
    }

    func preparationFailed(_ id: UUID, message: String) {
        update(id) { $0.state = .failed(message) }
    }

    func retryUpload(_ id: UUID, api: APIClient, brandId: String) {
        guard attachments.first(where: { $0.id == id })?.file != nil else { return }
        startUpload(id, api: api, brandId: brandId)
    }

    func remove(_ id: UUID) {
        uploads[id]?.cancel()
        uploads[id] = nil
        attachments.removeAll { $0.id == id }
    }

    /// Uploaded assets belong to one brand; switching brands drops them.
    func clearAttachments() {
        uploads.values.forEach { $0.cancel() }
        uploads = [:]
        attachments = []
    }

    private func startUpload(_ id: UUID, api: APIClient, brandId: String) {
        guard let file = attachments.first(where: { $0.id == id })?.file else { return }
        update(id) { $0.state = .uploading(0) }
        // Strong capture is fine: the task ends with the upload and is cancelled on remove/reset.
        let model = self
        uploads[id] = Task {
            do {
                let asset = try await api.uploadAsset(file, brandId: brandId) { fraction in
                    Task { @MainActor in model.reportProgress(id, fraction) }
                }
                model.update(id) { $0.state = .uploaded(asset) }
            } catch {
                let error = APIError.from(error)
                if error == .cancelled { return }
                model.update(id) { $0.state = .failed(error.localizedDescription) }
            }
            model.uploads[id] = nil
        }
    }

    private func reportProgress(_ id: UUID, _ fraction: Double) {
        update(id) { attachment in
            if case .uploading = attachment.state { attachment.state = .uploading(fraction) }
        }
    }

    private func update(_ id: UUID, _ change: (inout Attachment) -> Void) {
        guard let index = attachments.firstIndex(where: { $0.id == id }) else { return }
        change(&attachments[index])
    }
}
