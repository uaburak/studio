import AppKit
import StudioKit
import UniformTypeIdentifiers

/// Turns files the user picked for the brand kit into uploads (`POST /api/assets`).
enum BrandKitFiles {
    enum Slot {
        case logo
        case font
        case sample

        var assetKind: AssetKind {
            switch self {
            case .logo: .logo
            case .font: .font
            case .sample: .image
            }
        }

        /// What the open panel offers.
        var fileTypes: [UTType] {
            switch self {
            case .logo: [.png, .jpeg, .webP, .svg]
            case .font: ["ttf", "otf", "woff", "woff2"].compactMap { UTType(filenameExtension: $0) }
            case .sample: ImageImport.fileTypes
            }
        }

        var panelMessage: String {
            switch self {
            case .logo: "Logo dosyalarını seç (PNG, SVG, JPEG, WebP). Açık ve koyu zemin sürümlerini ayrı ayrı ekleyebilirsin."
            case .font: "Font dosyalarını seç (WOFF2, WOFF, TTF, OTF). Lisansını notlara yazmayı unutma."
            case .sample: "Markanın daha önce paylaştığı post görsellerini seç (en az 3, en fazla 12)."
            }
        }
    }

    enum Failure: LocalizedError, Equatable {
        case unreadable(String)
        case unsupported(String)
        case tooLarge(String, String)

        var errorDescription: String? {
            switch self {
            case .unreadable(let name): "\(name) okunamadı."
            case .unsupported(let name): "\(name) bu bölüme uygun bir dosya türü değil."
            case .tooLarge(let name, let limit): "\(name) \(limit) sınırını aşıyor."
            }
        }
    }

    static let fontMimes = ["woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf"]
    static let fontMaxBytes = 5 * 1024 * 1024
    static let svgMaxBytes = 2 * 1024 * 1024

    static func upload(from url: URL, slot: Slot) throws -> UploadFile {
        let name = url.lastPathComponent
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { throw Failure.unreadable(name) }
        return try upload(data: data, filename: name, slot: slot)
    }

    static func upload(data: Data, filename: String, slot: Slot) throws -> UploadFile {
        let ext = (filename as NSString).pathExtension.lowercased()
        switch slot {
        case .font:
            guard let mime = fontMimes[ext] else { throw Failure.unsupported(filename) }
            guard data.count <= fontMaxBytes else { throw Failure.tooLarge(filename, "5 MB") }
            return UploadFile(filename: filename, mimeType: mime, data: data)
        case .logo where ext == "svg":
            guard data.count <= svgMaxBytes else { throw Failure.tooLarge(filename, "2 MB") }
            guard String(decoding: data.prefix(4096), as: UTF8.self).range(of: "<svg", options: .caseInsensitive) != nil else {
                throw Failure.unreadable(filename)
            }
            return UploadFile(filename: filename, mimeType: "image/svg+xml", data: data)
        case .logo, .sample:
            do {
                return try ImageImport.from(data: data, filename: filename).file
            } catch let error as ImageImport.Failure {
                if case .tooLarge = error { throw Failure.tooLarge(filename, "20 MB") }
                throw Failure.unreadable(filename)
            } catch {
                throw Failure.unreadable(filename)
            }
        }
    }
}
