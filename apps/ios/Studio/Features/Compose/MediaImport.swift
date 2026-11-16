import AVFoundation
import CoreTransferable
import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Turns a Photos selection into an upload the API accepts
/// (`ASSET_MIME_RULES`: JPEG/PNG/WebP/GIF images up to 20 MiB, MP4/MOV video up to 50 MiB).
/// Photos are re-encoded to JPEG because the library hands out HEIC, which the API refuses.
enum MediaImport {
    static let maxImageBytes = 20 * 1024 * 1024
    static let maxVideoBytes = 50 * 1024 * 1024

    struct Imported: Sendable {
        var file: UploadFile
        var thumbnail: UIImage?
        var isVideo: Bool
    }

    enum ImportError: Error, LocalizedError, Equatable {
        case unreadable
        case unsupported
        case tooLarge(bytes: Int, limit: Int)

        var errorDescription: String? {
            switch self {
            case .unreadable: "Dosya okunamadı."
            case .unsupported: "Bu dosya türü desteklenmiyor (yalnızca fotoğraf ve MP4/MOV video)."
            case .tooLarge(let bytes, let limit):
                "Dosya çok büyük: \(Formatting.bytes(bytes)) (en fazla \(Formatting.bytes(limit)))."
            }
        }
    }

    static func load(_ item: PhotosPickerItem) async throws -> Imported {
        let isVideo = item.supportedContentTypes.contains { $0.conforms(to: .movie) }
        if isVideo {
            guard let movie = try await item.loadTransferable(type: PickedMovie.self) else { throw ImportError.unreadable }
            return try await video(at: movie.url)
        }
        guard let data = try await item.loadTransferable(type: Data.self) else { throw ImportError.unreadable }
        return try image(from: data)
    }

    static func image(from data: Data, maxBytes: Int = maxImageBytes) throws -> Imported {
        guard let image = UIImage(data: data), let jpeg = image.jpegData(compressionQuality: 0.9) else {
            throw ImportError.unsupported
        }
        guard jpeg.count <= maxBytes else { throw ImportError.tooLarge(bytes: jpeg.count, limit: maxBytes) }
        let pixelWidth = Int(image.size.width * image.scale)
        let pixelHeight = Int(image.size.height * image.scale)
        let file = UploadFile(
            filename: "foto-\(UUID().uuidString.prefix(8).lowercased()).jpg", mimeType: "image/jpeg",
            data: jpeg, width: pixelWidth, height: pixelHeight, durationMs: nil)
        return Imported(file: file, thumbnail: image.preparingThumbnail(of: CGSize(width: 160, height: 160)), isVideo: false)
    }

    static func video(at url: URL, maxBytes: Int = maxVideoBytes) async throws -> Imported {
        defer { try? FileManager.default.removeItem(at: url) }
        let ext = url.pathExtension.lowercased()
        let mime: String
        switch ext {
        case "mov": mime = "video/quicktime"
        case "mp4", "m4v": mime = "video/mp4"
        default: throw ImportError.unsupported
        }
        let size = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        guard size <= maxBytes else { throw ImportError.tooLarge(bytes: size, limit: maxBytes) }
        let data = try Data(contentsOf: url)

        let asset = AVURLAsset(url: url)
        let duration = try? await asset.load(.duration)
        var width: Int?
        var height: Int?
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (natural, transform) = try? await track.load(.naturalSize, .preferredTransform) {
            let rect = CGRect(origin: .zero, size: natural).applying(transform)
            width = Int(abs(rect.width))
            height = Int(abs(rect.height))
        }
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 320, height: 320)
        let thumbnail = try? await generator.image(at: .zero).image

        let ms = duration.map { Int(($0.seconds * 1000).rounded()) }.flatMap { $0 > 0 ? $0 : nil }
        let file = UploadFile(
            filename: "video-\(UUID().uuidString.prefix(8).lowercased()).\(ext == "m4v" ? "mp4" : ext)",
            mimeType: mime, data: data, width: width, height: height, durationMs: ms)
        return Imported(file: file, thumbnail: thumbnail.map { UIImage(cgImage: $0) }, isVideo: true)
    }
}

/// A movie from the Photos library, copied to a temporary file we own.
struct PickedMovie: Transferable {
    let url: URL

    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(contentType: .movie) { movie in
            SentTransferredFile(movie.url)
        } importing: { received in
            let target = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension.isEmpty ? "mov" : received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: target)
            return PickedMovie(url: target)
        }
    }
}
