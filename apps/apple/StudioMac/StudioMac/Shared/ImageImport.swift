import AppKit
import StudioKit
import UniformTypeIdentifiers

/// An image the user pasted, dropped or picked, ready to upload.
struct ImportedImage {
    var file: UploadFile
    var thumbnail: NSImage
}

enum ImageImport {
    enum Failure: LocalizedError {
        case unreadable(String)
        case tooLarge(String)

        var errorDescription: String? {
            switch self {
            case .unreadable(let name): "\(name) okunamadı ya da bir görsel değil."
            case .tooLarge(let name): "\(name) 20 MB sınırını aşıyor."
            }
        }
    }

    /// Image file types the composer accepts.
    static let fileTypes: [UTType] = [.png, .jpeg, .webP, .gif, .heic, .tiff]

    /// A file this large is refused before it is read (an image never needs it; HEIC/TIFF are
    /// converted to JPEG and must end up under the 20 MB upload limit anyway).
    static let maxSourceBytes = 100 * 1024 * 1024

    /// The file's size without reading it (nil when unknown).
    static func fileSize(_ url: URL) -> Int? {
        (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize
    }

    static func from(url: URL) throws -> ImportedImage {
        let name = url.lastPathComponent
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        if let size = fileSize(url), size > maxSourceBytes { throw Failure.tooLarge(name) }
        guard let data = try? Data(contentsOf: url) else { throw Failure.unreadable(name) }
        return try from(data: data, filename: name)
    }

    static func from(data: Data, filename: String) throws -> ImportedImage {
        guard let image = NSImage(data: data), let rep = image.representations.first else { throw Failure.unreadable(filename) }
        let type = UTType(filenameExtension: (filename as NSString).pathExtension.lowercased())
        let width = rep.pixelsWide > 0 ? rep.pixelsWide : Int(image.size.width)
        let height = rep.pixelsHigh > 0 ? rep.pixelsHigh : Int(image.size.height)
        var file: UploadFile
        switch type {
        case .some(.png): file = UploadFile(filename: filename, mimeType: "image/png", data: data)
        case .some(.jpeg): file = UploadFile(filename: filename, mimeType: "image/jpeg", data: data)
        case .some(.webP): file = UploadFile(filename: filename, mimeType: "image/webp", data: data)
        case .some(.gif): file = UploadFile(filename: filename, mimeType: "image/gif", data: data)
        default:
            // HEIC, TIFF, pasted bitmaps: the API accepts JPEG/PNG/WebP/GIF only.
            guard let jpeg = jpegData(image) else { throw Failure.unreadable(filename) }
            let base = (filename as NSString).deletingPathExtension
            file = UploadFile(filename: (base.isEmpty ? "gorsel" : base) + ".jpg", mimeType: "image/jpeg", data: jpeg)
        }
        guard file.data.count <= AssetMimeRules.imageMaxBytes else { throw Failure.tooLarge(filename) }
        file.width = width > 0 ? width : nil
        file.height = height > 0 ? height : nil
        return ImportedImage(file: file, thumbnail: image)
    }

    static func jpegData(_ image: NSImage) -> Data? {
        guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff) else { return nil }
        return bitmap.representation(using: .jpeg, properties: [.compressionFactor: 0.9])
    }

    /// Images on a pasteboard: image files first, then raw image data.
    static func images(from pasteboard: NSPasteboard) -> (images: [ImportedImage], errors: [String]) {
        var images: [ImportedImage] = []
        var errors: [String] = []
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: fileTypes.map(\.identifier),
        ]
        if let urls = pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL], !urls.isEmpty {
            for url in urls {
                do { images.append(try from(url: url)) } catch { errors.append(error.localizedDescription) }
            }
            return (images, errors)
        }
        for type in [NSPasteboard.PasteboardType.png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier)] {
            if let data = pasteboard.data(forType: type) {
                let ext = type == .png ? "png" : type == .tiff ? "tiff" : "jpg"
                do { images.append(try from(data: data, filename: "yapistirilan.\(ext)")) } catch { errors.append(error.localizedDescription) }
                break
            }
        }
        return (images, errors)
    }

    /// Image file URLs on a dragging / general pasteboard.
    static func imageURLs(from pasteboard: NSPasteboard) -> [URL] {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: fileTypes.map(\.identifier),
        ]
        return pasteboard.readObjects(forClasses: [NSURL.self], options: options) as? [URL] ?? []
    }

    static func pasteboardHasImages(_ pasteboard: NSPasteboard) -> Bool {
        let options: [NSPasteboard.ReadingOptionKey: Any] = [
            .urlReadingFileURLsOnly: true,
            .urlReadingContentsConformToTypes: fileTypes.map(\.identifier),
        ]
        if pasteboard.canReadObject(forClasses: [NSURL.self], options: options) { return true }
        return pasteboard.availableType(from: [.png, .tiff, NSPasteboard.PasteboardType(UTType.jpeg.identifier)]) != nil
    }

    /// Ask for images with the system open panel.
    @MainActor
    static func pick(multiple: Bool = true) -> [URL] {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = fileTypes
        panel.allowsMultipleSelection = multiple
        panel.canChooseDirectories = false
        panel.prompt = "Ekle"
        panel.message = "Eklenecek görselleri seç"
        return panel.runModal() == .OK ? panel.urls : []
    }
}
