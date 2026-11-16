import AppKit
import StudioKit
import SwiftUI

/// Loads and caches asset images (rendered slides, attachments) through the data service.
@MainActor
@Observable
final class ImageStore {
    weak var app: AppModel?
    private(set) var images: [EntityID: NSImage] = [:]
    private(set) var failed: Set<EntityID> = []
    private var loading: Set<EntityID> = []
    /// Local images (e.g. a just-uploaded attachment) shown before the server copy loads.
    func seed(_ image: NSImage, for assetId: EntityID) { images[assetId] = image }

    /// Cached image; call `load` (from `.task`) to fetch it.
    func image(_ assetId: EntityID) -> NSImage? { images[assetId] }

    func load(_ assetId: EntityID) {
        guard images[assetId] == nil, !loading.contains(assetId), !failed.contains(assetId), let service = app?.dataService else { return }
        loading.insert(assetId)
        Task {
            defer { loading.remove(assetId) }
            do {
                let data = try await service.imageData(assetId: assetId)
                if let image = NSImage(data: data) { images[assetId] = image } else { failed.insert(assetId) }
            } catch {
                failed.insert(assetId)
            }
        }
    }

    func clear() {
        images = [:]
        failed = []
    }
}

/// An asset image, filled into its frame; neutral placeholder while loading.
struct AssetImage: View {
    @Environment(AppModel.self) private var app
    var assetId: EntityID
    var contentMode: ContentMode = .fill

    var body: some View {
        if let image = app.images.image(assetId) {
            Image(nsImage: image).resizable().aspectRatio(contentMode: contentMode)
        } else {
            Rectangle().fill(Theme.fill)
                .task(id: assetId) { app.images.load(assetId) }
        }
    }
}
