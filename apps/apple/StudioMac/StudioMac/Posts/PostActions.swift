import AppKit
import Quartz
import StudioKit

// MARK: - Export

/// One entry of an export menu: a format and the slides it covers (nil = all).
final class ExportChoice: NSObject {
    let format: PostExportFormat
    let slides: [Int]?

    init(format: PostExportFormat, slides: [Int]?) {
        self.format = format
        self.slides = slides
    }
}

/// Export files of a post version to disk (shared by the grid and the opened post).
@MainActor
enum PostFileExport {
    /// The export menu: JPEG / PNG for this slide or all slides, one PDF.
    static func menu(target: AnyObject, action: Selector, slideCount: Int, currentSlide: Int?, disabledReason: String?) -> NSMenu {
        let menu = NSMenu(title: "Dışa aktar")
        func add(_ title: String, _ choice: ExportChoice) {
            let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
            item.target = target
            item.representedObject = choice
            item.isEnabled = disabledReason == nil
            if let disabledReason { item.toolTip = disabledReason }
            menu.addItem(item)
        }
        if slideCount > 1, let currentSlide {
            add("JPEG — bu slayt (\(currentSlide + 1))", ExportChoice(format: .jpeg, slides: [currentSlide]))
            add("JPEG — tüm slaytlar (\(slideCount))", ExportChoice(format: .jpeg, slides: nil))
            add("PNG — bu slayt (\(currentSlide + 1))", ExportChoice(format: .png, slides: [currentSlide]))
            add("PNG — tüm slaytlar (\(slideCount))", ExportChoice(format: .png, slides: nil))
            add("PDF — carousel (\(slideCount) sayfa)", ExportChoice(format: .pdf, slides: nil))
        } else {
            add(slideCount > 1 ? "JPEG — tüm slaytlar (\(slideCount))" : "JPEG", ExportChoice(format: .jpeg, slides: nil))
            add(slideCount > 1 ? "PNG — tüm slaytlar (\(slideCount))" : "PNG", ExportChoice(format: .png, slides: nil))
            add(slideCount > 1 ? "PDF — carousel (\(slideCount) sayfa)" : "PDF", ExportChoice(format: .pdf, slides: nil))
        }
        return menu
    }

    /// Ask where to save: a file for one output, a folder for several.
    static func chooseDestination(fileCount: Int, suggestedName: String, format: PostExportFormat, window: NSWindow?) async -> URL? {
        if fileCount == 1 {
            let panel = NSSavePanel()
            panel.nameFieldStringValue = suggestedName
            panel.canCreateDirectories = true
            panel.allowedContentTypes = [format == .pdf ? .pdf : (format == .png ? .png : .jpeg)]
            panel.prompt = "Kaydet"
            return await run(panel, window: window)
        }
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.prompt = "Bu klasöre kaydet"
        panel.message = "\(fileCount) dosya bu klasöre kaydedilecek."
        return await run(panel, window: window)
    }

    private static func run(_ panel: NSSavePanel, window: NSWindow?) async -> URL? {
        if let window {
            let response = await panel.beginSheetModal(for: window)
            return response == .OK ? panel.url : nil
        }
        return panel.runModal() == .OK ? panel.url : nil
    }

    /// How many files a choice produces.
    static func fileCount(_ choice: ExportChoice, slideCount: Int) -> Int {
        choice.format == .pdf ? 1 : (choice.slides?.count ?? slideCount)
    }
}

// MARK: - Quick Look

/// Rendered slides as local files (Quick Look and the share sheet need file URLs).
@MainActor
enum RenderFileCache {
    static var folder: URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("Studio/Önizleme", isDirectory: true)
    }

    static func files(for assetIds: [EntityID], service: any StudioDataService) async -> [URL] {
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        var urls: [URL] = []
        for id in assetIds {
            let url = folder.appendingPathComponent("\(id).jpg")
            if !FileManager.default.fileExists(atPath: url.path) {
                guard let data = try? await service.imageData(assetId: id) else { continue }
                try? data.write(to: url, options: .atomic)
            }
            urls.append(url)
        }
        return urls
    }
}

/// Space bar preview of a post's rendered slides in the system Quick Look panel.
@MainActor
final class PostQuickLook: NSObject, @preconcurrency QLPreviewPanelDataSource, QLPreviewPanelDelegate {
    static let shared = PostQuickLook()
    private(set) var urls: [URL] = []

    /// Show `assetIds` (or close the panel when it already shows them).
    func toggle(assetIds: [EntityID], service: any StudioDataService) {
        guard let panel = QLPreviewPanel.shared() else { return }
        if panel.isVisible {
            panel.orderOut(nil)
            return
        }
        guard !assetIds.isEmpty else {
            NSSound.beep()
            return
        }
        Task {
            urls = await RenderFileCache.files(for: assetIds, service: service)
            guard !urls.isEmpty else { return }
            panel.dataSource = self
            panel.delegate = self
            panel.currentPreviewItemIndex = 0
            panel.reloadData()
            panel.makeKeyAndOrderFront(nil)
        }
    }

    func numberOfPreviewItems(in panel: QLPreviewPanel!) -> Int { urls.count }

    func previewPanel(_ panel: QLPreviewPanel!, previewItemAt index: Int) -> (any QLPreviewItem)! {
        urls[index] as NSURL
    }
}

// MARK: - Deletion

@MainActor
enum PostDeletion {
    /// "Postu sil?" confirmation; true when the user chose Sil.
    static func confirm(title: String, window: NSWindow?) async -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "“\(title)” silinsin mi?"
        alert.informativeText = "Post, tüm sürümleri ve render edilmiş görselleriyle birlikte silinir. Bu işlem geri alınamaz."
        alert.addButton(withTitle: "Sil")
        alert.addButton(withTitle: "Vazgeç")
        alert.buttons.first?.hasDestructiveAction = true
        if let window {
            return await alert.beginSheetModal(for: window) == .alertFirstButtonReturn
        }
        return alert.runModal() == .alertFirstButtonReturn
    }
}
