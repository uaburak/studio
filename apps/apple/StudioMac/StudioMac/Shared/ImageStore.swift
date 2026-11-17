import AppKit
import Foundation
import Observation
import StudioKit

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

    func isLoading(_ assetId: EntityID) -> Bool { loading.contains(assetId) }

    /// Cached image; call `load` to fetch it.
    func image(_ assetId: EntityID) -> NSImage? { images[assetId] }

    /// When each failed image failed: one transient error (or an asset that was not readable yet,
    /// right after a generation) must not leave a grey placeholder for the rest of the session.
    @ObservationIgnored private var failedAt: [EntityID: Date] = [:]
    static let retryAfter: TimeInterval = 10
    @ObservationIgnored var now: () -> Date = Date.init

    func load(_ assetId: EntityID) {
        guard images[assetId] == nil, !loading.contains(assetId), let service = app?.dataService else { return }
        if failed.contains(assetId) {
            guard let at = failedAt[assetId], now().timeIntervalSince(at) >= Self.retryAfter else { return }
        }
        loading.insert(assetId)
        Task {
            defer { loading.remove(assetId) }
            do {
                let data = try await service.imageData(assetId: assetId)
                // Decoded on a background thread: drawing it later never decodes on the main thread.
                if let image = await ImageDecoding.decode(data) {
                    images[assetId] = image
                    failed.remove(assetId)
                    failedAt[assetId] = nil
                } else {
                    markFailed(assetId)
                }
            } catch {
                markFailed(assetId)
            }
        }
    }

    private func markFailed(_ assetId: EntityID) {
        failed.insert(assetId)
        failedAt[assetId] = now()
    }

    func clear() {
        images = [:]
        failed = []
        failedAt = [:]
    }
}

/// Pure AppKit image view backed by `ImageStore` with aspect-fill or aspect-fit drawing
/// and a neutral `Theme.fill` placeholder while loading.
final class AssetImageView: NSView {
    enum ContentMode {
        case fill
        case fit
    }

    private weak var store: ImageStore?
    private var observation: ObservationToken?

    var assetId: EntityID? {
        didSet {
            guard assetId != oldValue else { return }
            bind()
        }
    }

    var localImage: NSImage? {
        didSet {
            needsDisplay = true
        }
    }

    var contentMode: ContentMode = .fill {
        didSet { needsDisplay = true }
    }

    var cornerRadius: CGFloat = 0 {
        didSet {
            layer?.cornerRadius = cornerRadius
            layer?.cornerCurve = .continuous
            layer?.masksToBounds = cornerRadius > 0
        }
    }

    init(store: ImageStore?, assetId: EntityID? = nil, contentMode: ContentMode = .fill, cornerRadius: CGFloat = 0) {
        self.store = store
        self.assetId = assetId
        self.contentMode = contentMode
        self.cornerRadius = cornerRadius
        super.init(frame: .zero)
        wantsLayer = true
        layer?.cornerRadius = cornerRadius
        layer?.cornerCurve = .continuous
        layer?.masksToBounds = cornerRadius > 0
        bind()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(store: ImageStore?, assetId: EntityID?) {
        self.store = store
        self.assetId = assetId
        bind()
    }

    private func bind() {
        observation?.cancel()
        observation = nil
        guard let store, let assetId else {
            needsDisplay = true
            return
        }
        store.load(assetId)
        observation = observe { [weak self, weak store] in
            guard let self, let store else { return }
            _ = store.image(assetId)
            _ = store.failed.contains(assetId)
            self.needsDisplay = true
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let bounds = self.bounds
        guard bounds.width > 0, bounds.height > 0 else { return }
        let resolvedImage = localImage ?? assetId.flatMap { store?.image($0) }
        guard let image = resolvedImage, image.size.width > 0, image.size.height > 0 else {
            Theme.fill.setFill()
            bounds.fill()
            return
        }

        let imgSize = image.size
        let scaleX = bounds.width / imgSize.width
        let scaleY = bounds.height / imgSize.height
        let scale = contentMode == .fill ? max(scaleX, scaleY) : min(scaleX, scaleY)
        let drawSize = NSSize(width: imgSize.width * scale, height: imgSize.height * scale)
        let drawRect = NSRect(
            x: bounds.midX - drawSize.width / 2,
            y: bounds.midY - drawSize.height / 2,
            width: drawSize.width,
            height: drawSize.height
        )
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: bounds).addClip()
        image.draw(in: drawRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
        NSGraphicsContext.restoreGraphicsState()
    }
}
