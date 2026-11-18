import AVFoundation
import PhotosUI
import StudioKit
import UIKit
import UniformTypeIdentifiers

/// Pictures and videos from Photos, the camera or Files (N21). Pictures come back as `UIImage`
/// (prepared like every other photo by `IOSImageImport`); videos as file copies in a temporary
/// folder of their own (the picker's copy disappears after its callback), which the caller
/// deletes after the upload (`MediaPicking.discard`).
@MainActor
final class MediaPicking: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDocumentPickerDelegate {
    struct Picked {
        var images: [UIImage] = []
        var videos: [URL] = []
        var isEmpty: Bool { images.isEmpty && videos.isEmpty }
    }

    private var onPick: ((Picked) -> Void)?
    private var retainSelf: MediaPicking?
    private weak var presenter: UIViewController?

    private func hold(_ presenter: UIViewController, _ onPick: @escaping (Picked) -> Void) {
        self.onPick = onPick
        self.presenter = presenter
        retainSelf = self
    }

    static func library(from presenter: UIViewController, limit: Int = 10, onPick: @escaping (Picked) -> Void) {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .any(of: [.images, .videos])
        config.selectionLimit = limit
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        let handler = MediaPicking()
        handler.hold(presenter, onPick)
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    /// Photo or video with the camera.
    static func camera(from presenter: UIViewController, onPick: @escaping (Picked) -> Void) {
        guard ImagePicking.cameraAvailable else {
            presenter.presentError("Bu cihazda kamera yok.")
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.mediaTypes = [UTType.image.identifier, UTType.movie.identifier]
        picker.videoQuality = .typeHigh
        let handler = MediaPicking()
        handler.hold(presenter, onPick)
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    static func files(from presenter: UIViewController, limit: Int = 10, onPick: @escaping (Picked) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image, .movie], asCopy: true)
        picker.allowsMultipleSelection = limit > 1
        let handler = MediaPicking()
        handler.hold(presenter, onPick)
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    /// Delete a picked video's temporary folder.
    nonisolated static func discard(_ video: URL) {
        let folder = video.deletingLastPathComponent()
        if folder.lastPathComponent.hasPrefix(folderPrefix) { try? FileManager.default.removeItem(at: folder) }
    }

    nonisolated static let folderPrefix = "studio-video-"

    nonisolated static func newFolder() -> URL {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("\(folderPrefix)\(UUID().uuidString)", isDirectory: true)
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return folder
    }

    private func finish(_ picked: Picked, failures: Int) {
        let presenter = presenter
        if !picked.isEmpty { onPick?(picked) }
        if failures > 0 {
            let message = failures == 1
                ? "Bir dosya alınamadı. Asıl dosya iCloud'da olabilir; internet bağlantını kontrol edip yeniden dene."
                : "\(failures) dosya alınamadı. Asıl dosyalar iCloud'da olabilir; internet bağlantını kontrol edip yeniden dene."
            (presenter?.presentedViewController == nil ? presenter : presenter?.presentedViewController)?.presentError(message, title: "Eklenemedi")
        }
        retainSelf = nil
    }

    // MARK: Photos

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        nonisolated(unsafe) let providers = results.map(\.itemProvider)
        MainActor.assumeIsolated {
            picker.dismiss(animated: true) {
                Task { @MainActor in
                    var picked = Picked()
                    var failures = 0
                    for provider in providers {
                        if provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier) {
                            if let url = await Self.copyVideo(provider) { picked.videos.append(url) } else { failures += 1 }
                        } else if let image = await Self.loadImage(provider) {
                            picked.images.append(image)
                        } else {
                            failures += 1
                        }
                    }
                    self.finish(picked, failures: failures)
                }
            }
        }
    }

    private static func loadImage(_ provider: NSItemProvider) async -> UIImage? {
        guard provider.canLoadObject(ofClass: UIImage.self) else { return nil }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: UIImage.self) { object, _ in
                continuation.resume(returning: object as? UIImage)
            }
        }
    }

    private static func copyVideo(_ provider: NSItemProvider) async -> URL? {
        await withCheckedContinuation { continuation in
            _ = provider.loadFileRepresentation(for: .movie, openInPlace: false) { url, _, _ in
                guard let url else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: Self.copyIntoNewFolder(url))
            }
        }
    }

    nonisolated private static func copyIntoNewFolder(_ url: URL) -> URL? {
        let target = newFolder().appendingPathComponent(url.lastPathComponent.isEmpty ? "video.mov" : url.lastPathComponent)
        do {
            try FileManager.default.copyItem(at: url, to: target)
            return target
        } catch {
            return nil
        }
    }

    // MARK: Camera

    nonisolated func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        let movie = (info[.mediaURL] as? URL).flatMap { Self.copyIntoNewFolder($0) }
        MainActor.assumeIsolated {
            picker.dismiss(animated: true) {
                var picked = Picked()
                if let movie { picked.videos.append(movie) } else if let image { picked.images.append(image) }
                self.finish(picked, failures: picked.isEmpty ? 1 : 0)
            }
        }
    }

    nonisolated func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            retainSelf = nil
        }
    }

    // MARK: Files

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        _ = MainActor.assumeIsolated {
            Task { @MainActor in
                var picked = Picked()
                var failures = 0
                for url in urls {
                    let scoped = url.startAccessingSecurityScopedResource()
                    defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                    let type = UTType(filenameExtension: url.pathExtension)
                    if type?.conforms(to: .movie) == true {
                        if let copy = Self.copyIntoNewFolder(url) { picked.videos.append(copy) } else { failures += 1 }
                    } else if let data = try? Data(contentsOf: url), let image = UIImage(data: data) {
                        picked.images.append(image)
                    } else {
                        failures += 1
                    }
                }
                self.finish(picked, failures: failures)
            }
        }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { retainSelf = nil }
    }
}

/// A video's first frame, small (the composer chip, the media grid's own uploads).
enum VideoThumbnail {
    static func make(_ url: URL, side: CGFloat = 240) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: side, height: side)
        guard let (image, _) = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: image)
    }

    /// `1:05`.
    static func duration(_ ms: Int?) -> String? {
        guard let ms, ms > 0 else { return nil }
        let seconds = ms / 1000
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }
}
