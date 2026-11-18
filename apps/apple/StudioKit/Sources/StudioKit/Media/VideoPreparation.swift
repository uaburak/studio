import AVFoundation
import CoreMedia
import Foundation
import UniformTypeIdentifiers

/// A picked video ready for `POST /api/assets` (sent from disk, never read into memory).
public struct PreparedVideo: Sendable {
    public var file: UploadFile
    public var source: VideoSourceInfo
    /// Exported again (the original did not fit or was not an mp4 / mov).
    public var transcoded: Bool
    /// What the export used, for the progress text.
    public var preset: VideoExportPreset?
}

/// Reads a video file and, when `VideoUploadPlanner` says so, exports it again with
/// `AVAssetExportSession` (N21).
public enum VideoPreparation {
    /// Size, length, picture size (rotation applied) and codec of a local video file.
    public static func inspect(_ url: URL) async throws -> VideoSourceInfo {
        let asset = AVURLAsset(url: url)
        let duration: CMTime
        do {
            duration = try await asset.load(.duration)
        } catch {
            throw StudioAPIError.invalidConfiguration("Video okunamadı. Fotoğraflar'da açılıyorsa yeniden dene.")
        }
        let bytes = ((try? FileManager.default.attributesOfItem(atPath: url.path)[.size]) as? NSNumber)?.intValue ?? 0
        var info = VideoSourceInfo(
            bytes: bytes, durationMs: duration.isNumeric ? Int((duration.seconds * 1000).rounded()) : 0,
            mimeType: mimeType(of: url))
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (size, transform, formats) = try? await track.load(.naturalSize, .preferredTransform, .formatDescriptions) {
            let shown = CGRect(origin: .zero, size: size).applying(transform)
            info.width = Int(abs(shown.width).rounded())
            info.height = Int(abs(shown.height).rounded())
            if let format = formats.first {
                info.codec = VideoCodec(fourCC: fourCC(CMFormatDescriptionGetMediaSubType(format)))
            }
        } else {
            throw StudioAPIError.invalidConfiguration("Bu dosyada görüntü yok; video olarak eklenemez.")
        }
        return info
    }

    /// Make `source` (a file this process may keep reading) ready to upload: as it is when it
    /// fits, else exported to an mp4 in `workDirectory`. `progress` reports the export (0…1).
    /// The caller deletes `workDirectory` files after the upload.
    public static func prepare(
        _ source: URL, workDirectory: URL, filename: String? = nil,
        limit: Int = VideoUploadPlanner.maxBytes,
        progress: (@Sendable (Double) -> Void)? = nil
    ) async throws -> PreparedVideo {
        let info = try await inspect(source)
        let base = (filename ?? source.lastPathComponent).replacingOccurrences(of: "/", with: "-")
        let stem = (base as NSString).deletingPathExtension.isEmpty ? "video" : (base as NSString).deletingPathExtension
        switch VideoUploadPlanner.decide(info, limit: limit) {
        case .refuse(let reason):
            throw StudioAPIError.invalidConfiguration(reason)
        case .asIs(let mime):
            let ext = mime == "video/quicktime" ? "mov" : "mp4"
            progress?(1)
            return PreparedVideo(
                file: UploadFile(filename: "\(stem).\(ext)", mimeType: mime, fileURL: source, width: info.width, height: info.height, durationMs: info.durationMs),
                source: info, transcoded: false, preset: nil)
        case .transcode(let presets):
            try FileManager.default.createDirectory(at: workDirectory, withIntermediateDirectories: true)
            let asset = AVURLAsset(url: source)
            for (index, preset) in presets.enumerated() {
                try Task.checkCancellation()
                guard let session = AVAssetExportSession(asset: asset, presetName: preset.rawValue) else { continue }
                let isLast = index == presets.count - 1
                if !isLast, let estimate = try? await session.estimatedOutputFileLengthInBytes, estimate > 0,
                   !VideoUploadPlanner.fits(estimatedBytes: Int(estimate), limit: limit) {
                    continue
                }
                // Never larger than the limit: the export stops at it (checked below).
                session.fileLengthLimit = Int64(limit - 64 * 1024)
                session.shouldOptimizeForNetworkUse = true
                let output = workDirectory.appendingPathComponent("\(stem)-\(UUID().uuidString.prefix(8)).mp4")
                // AVAssetExportSession is thread-safe for reading its states while it exports.
                nonisolated(unsafe) let observed = session
                let watcher = Task {
                    for await state in observed.states(updateInterval: 0.25) {
                        if case .exporting(let exporting) = state { progress?(min(0.99, exporting.fractionCompleted)) }
                    }
                }
                do {
                    try await session.export(to: output, as: .mp4)
                    watcher.cancel()
                } catch {
                    watcher.cancel()
                    try? FileManager.default.removeItem(at: output)
                    if Task.isCancelled { throw CancellationError() }
                    continue
                }
                let bytes = ((try? FileManager.default.attributesOfItem(atPath: output.path)[.size]) as? NSNumber)?.intValue ?? 0
                let exported = (try? await AVURLAsset(url: output).load(.duration)).map { Int(($0.seconds * 1000).rounded()) } ?? 0
                if VideoUploadPlanner.accepts(outputBytes: bytes, outputDurationMs: exported, sourceDurationMs: info.durationMs, limit: limit) {
                    progress?(1)
                    let out = (try? await inspect(output)) ?? info
                    return PreparedVideo(
                        file: UploadFile(filename: "\(stem).mp4", mimeType: "video/mp4", fileURL: output, width: out.width, height: out.height, durationMs: exported),
                        source: info, transcoded: true, preset: preset)
                }
                try? FileManager.default.removeItem(at: output)
            }
            throw StudioAPIError.invalidConfiguration(
                "Video \(VideoUploadPlanner.megabytes(limit)) sınırına sığacak şekilde küçültülemedi. Daha kısa bir bölümünü seçip yeniden dene.")
        }
    }

    static func mimeType(of url: URL) -> String? {
        if let mime = VideoUploadPlanner.mimeType(forExtension: url.pathExtension) { return mime }
        guard let type = UTType(filenameExtension: url.pathExtension) else { return nil }
        if type.conforms(to: .mpeg4Movie) { return "video/mp4" }
        if type.conforms(to: .quickTimeMovie) { return "video/quicktime" }
        return type.preferredMIMEType
    }

    static func fourCC(_ code: FourCharCode) -> String {
        let bytes = [24, 16, 8, 0].map { UInt8((code >> UInt32($0)) & 0xFF) }
        return String(decoding: bytes, as: UTF8.self).trimmingCharacters(in: .whitespaces)
    }
}
