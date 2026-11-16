import Foundation

// MARK: - Posts screen filter

/// The status filter of the Mac posts screen (one pill per case).
public enum PostListFilter: String, CaseIterable, Sendable, Hashable {
    case all, ready, imageNeeded, approved, scheduled, published

    public var label: String {
        switch self {
        case .all: "Tümü"
        case .ready: "Hazır"
        case .imageNeeded: "Görsel bekliyor"
        case .approved: "Onaylandı"
        case .scheduled: "Zamanlandı"
        case .published: "Yayınlandı"
        }
    }

    public func matches(_ state: PostState) -> Bool {
        switch self {
        case .all: true
        case .ready: state == .ready
        case .imageNeeded: state == .imageNeeded || state == .imageUploaded
        case .approved: state == .approved
        case .scheduled: state == .scheduled || state == .publishing
        case .published: state == .published
        }
    }
}

extension PostBoard {
    public static func listCounts(_ cards: [PostCard]) -> [PostListFilter: Int] {
        var counts: [PostListFilter: Int] = [:]
        for filter in PostListFilter.allCases {
            counts[filter] = cards.filter { filter.matches($0.state) }.count
        }
        return counts
    }
}

// MARK: - Caption limits

/// Platform caption limits shown under the caption editor.
public enum CaptionLimits {
    public struct Usage: Sendable, Hashable {
        public var platform: Platform
        public var characters: Int
        public var limit: Int
        public var hashtags: Int
        /// Instagram allows 30 hashtags; others have no hard cap.
        public var hashtagLimit: Int?

        public var isOverLimit: Bool { characters > limit || (hashtagLimit.map { hashtags > $0 } ?? false) }
        /// `"1.234 / 2.200"`.
        public var label: String { "\(Self.grouped(characters)) / \(Self.grouped(limit))" }

        static func grouped(_ n: Int) -> String {
            let formatter = NumberFormatter()
            formatter.locale = TurkishFormat.locale
            formatter.numberStyle = .decimal
            return formatter.string(from: NSNumber(value: n)) ?? String(n)
        }
    }

    public static func limit(for platform: Platform) -> Int {
        switch platform {
        case .instagram: 2_200
        case .facebook: 63_206
        case .linkedin: 3_000
        case .unknown: 2_200
        }
    }

    public static func hashtagLimit(for platform: Platform) -> Int? {
        platform == .instagram ? 30 : nil
    }

    /// Characters as people count them (grapheme clusters; an emoji is one).
    public static func count(_ caption: String) -> Int { caption.count }

    public static func hashtags(in caption: String) -> Int {
        caption.split(whereSeparator: { $0.isWhitespace }).filter { $0.hasPrefix("#") && $0.count > 1 }.count
    }

    /// One usage line per target platform (Instagram when none is set).
    public static func usage(caption: String, platforms: [Platform]) -> [Usage] {
        let targets = platforms.filter { $0 != .unknown }
        return (targets.isEmpty ? [.instagram] : targets).map { platform in
            Usage(
                platform: platform, characters: count(caption), limit: limit(for: platform),
                hashtags: hashtags(in: caption), hashtagLimit: hashtagLimit(for: platform))
        }
    }
}

// MARK: - Waiting for a job

public enum JobWaitError: Error, Sendable, Equatable, LocalizedError {
    case failed(String)
    case cancelled
    case timedOut

    public var errorDescription: String? {
        switch self {
        case .failed(let message): message
        case .cancelled: "İş iptal edildi."
        case .timedOut: "İş zamanında bitmedi; Mac'teki işçi çalışıyor mu?"
        }
    }
}

extension StudioDataService {
    /// Poll a job until it finishes. Throws `JobWaitError` when it fails, is cancelled
    /// or takes longer than `timeout`.
    public func waitForJob(
        _ id: EntityID, timeout: Duration = .seconds(300), interval: Duration = .milliseconds(400),
        onProgress: (@Sendable (Job) -> Void)? = nil
    ) async throws -> Job {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while true {
            let job = try await job(id)
            onProgress?(job)
            switch job.status {
            case .succeeded: return job
            case .failed: throw JobWaitError.failed(job.error ?? "İş başarısız oldu.")
            case .cancelled: throw JobWaitError.cancelled
            default: break
            }
            if clock.now >= deadline { throw JobWaitError.timedOut }
            try await Task.sleep(for: interval)
        }
    }
}

// MARK: - Export

public enum PostExportFormat: String, CaseIterable, Sendable, Hashable {
    case jpeg, png, pdf

    public var label: String {
        switch self {
        case .jpeg: "JPEG"
        case .png: "PNG"
        case .pdf: "PDF"
        }
    }

    public var fileExtension: String {
        switch self {
        case .jpeg: "jpg"
        case .png: "png"
        case .pdf: "pdf"
        }
    }
}

/// One exported file, ready to be written.
public struct ExportedFile: Sendable, Hashable {
    public var filename: String
    public var data: Data

    public init(filename: String, data: Data) {
        self.filename = filename
        self.data = data
    }
}

/// Produces the files of a post version: JPEG (the rendered slides), PNG (lossless,
/// rendered on the Mac worker) and PDF (one multi-page document).
public struct PostExporter: Sendable {
    public let service: any StudioDataService
    public var timeout: Duration
    public var interval: Duration

    public init(service: any StudioDataService, timeout: Duration = .seconds(300), interval: Duration = .milliseconds(400)) {
        self.service = service
        self.timeout = timeout
        self.interval = interval
    }

    /// Base file name: `venta-borinc-v3`.
    public static func baseName(title: String, version: Int) -> String {
        let slug = Brand.slugify(title)
        return "\(slug.isEmpty ? "post" : slug)-v\(version)"
    }

    /// Files for `slides` (0-based; nil = all) of `version`. PDF always holds every slide.
    public func export(
        content: Content, version: ContentVersion, format: PostExportFormat, slides: [Int]? = nil,
        onProgress: (@Sendable (String) -> Void)? = nil
    ) async throws -> [ExportedFile] {
        let indices = (slides ?? Array(version.slides.indices)).filter { version.slides.indices.contains($0) }
        let base = Self.baseName(title: content.title, version: version.version)
        let multi = version.slides.count > 1
        func name(_ index: Int, _ ext: String) -> String { multi ? "\(base)-\(index + 1).\(ext)" : "\(base).\(ext)" }
        let progress: @Sendable (Job) -> Void = { job in
            if let message = job.progressMessage, !message.isEmpty { onProgress?(message) }
        }

        switch format {
        case .jpeg:
            var current = version
            if indices.contains(where: { current.slides[$0].renderedAssetId == nil }) {
                onProgress?("Eksik görseller render ediliyor")
                let job = try await service.render(contentId: content.id, ContentRenderRequest(version: version.version, format: .jpeg))
                _ = try await service.waitForJob(job.id, timeout: timeout, interval: interval, onProgress: progress)
                current = try await service.version(contentId: content.id, version: version.version)
            }
            var files: [ExportedFile] = []
            for index in indices {
                guard let assetId = current.slides[index].renderedAssetId else {
                    throw JobWaitError.failed("Slayt \(index + 1) render edilemedi.")
                }
                files.append(ExportedFile(filename: name(index, "jpg"), data: try await service.imageData(assetId: assetId)))
            }
            return files
        case .png:
            onProgress?("PNG hazırlanıyor")
            let job = try await service.render(
                contentId: content.id, ContentRenderRequest(version: version.version, format: .png, slides: indices))
            let done = try await service.waitForJob(job.id, timeout: timeout, interval: interval, onProgress: progress)
            let ids = ContentRenderOutput(done.output).pngAssetIds
            var files: [ExportedFile] = []
            for index in indices {
                guard ids.indices.contains(index), let assetId = ids[index] else {
                    throw JobWaitError.failed("Slayt \(index + 1) PNG olarak üretilemedi.")
                }
                files.append(ExportedFile(filename: name(index, "png"), data: try await service.imageData(assetId: assetId)))
            }
            return files
        case .pdf:
            onProgress?("PDF hazırlanıyor")
            let job = try await service.render(contentId: content.id, ContentRenderRequest(version: version.version, format: .pdf))
            let done = try await service.waitForJob(job.id, timeout: timeout, interval: interval, onProgress: progress)
            guard let pdfId = ContentRenderOutput(done.output).pdfAssetId else {
                throw JobWaitError.failed("PDF üretilemedi.")
            }
            return [ExportedFile(filename: "\(base).pdf", data: try await service.imageData(assetId: pdfId))]
        }
    }
}
