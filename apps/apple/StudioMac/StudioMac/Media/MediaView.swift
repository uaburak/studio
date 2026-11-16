import AppKit
import Foundation
import Observation
import StudioKit
import UniformTypeIdentifiers

enum MediaFilter: String, CaseIterable, Sendable, Hashable {
    case all
    case images
    case videos
    case documents

    var label: String {
        switch self {
        case .all: "Tümü"
        case .images: "Görseller"
        case .videos: "Videolar"
        case .documents: "Belgeler (PDF)"
        }
    }

    func matches(_ kind: AssetKind) -> Bool {
        switch self {
        case .all: true
        case .images: kind == .image || kind == .logo
        case .videos: kind == .video
        case .documents: kind == .document
        }
    }
}

struct AIGeneratorTarget: Equatable, Sendable {
    var brandId: EntityID
    var targetContentId: EntityID?
    var targetSlotId: String?
    var initialPrompt: String

    init(brandId: EntityID, targetContentId: EntityID? = nil, targetSlotId: String? = nil, initialPrompt: String = "") {
        self.brandId = brandId
        self.targetContentId = targetContentId
        self.targetSlotId = targetSlotId
        self.initialPrompt = initialPrompt
    }
}

/// Pure AppKit model for Medya Kütüphanesi (`MediaViewController`) & Gemini AI Image Generation.
@MainActor
@Observable
final class MediaModel {
    weak var app: AppModel?
    var filter: MediaFilter = .all
    private(set) var assets: [Asset] = []
    private(set) var isLoading = false
    private(set) var uploadProgress: Double?
    private(set) var activeAIJob: Job?
    var error: String?
    private var loadedBrandId: EntityID?

    var brandId: EntityID? { app?.currentBrandId }

    var visibleAssets: [Asset] {
        assets.filter { filter.matches($0.kind) }
    }

    var counts: [MediaFilter: Int] {
        var out: [MediaFilter: Int] = [:]
        for f in MediaFilter.allCases {
            out[f] = assets.filter { f.matches($0.kind) }.count
        }
        return out
    }

    var imageAssets: [Asset] {
        assets.filter { $0.kind == .image || $0.kind == .logo }
    }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            assets = try await app.dataService.assets(brandId: brandId, kind: nil)
            loadedBrandId = brandId
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func jobChanged(_ job: Job) {
        guard job.brandId == loadedBrandId else { return }
        if job.type == .imageGenerate {
            activeAIJob = job.status.isTerminal ? nil : job
            if job.status.isTerminal {
                Task { await load() }
            }
        }
    }

    static let allowedUploadTypes: [UTType] = [
        .png, .jpeg, .webP, .gif, .heic, .tiff, .svg,
        .mpeg4Movie, .quickTimeMovie,
        .pdf,
        .mp3, .mpeg4Audio, .wav,
    ]

    func pickAndUploadFiles() {
        let panel = NSOpenPanel()
        panel.allowedContentTypes = Self.allowedUploadTypes
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.prompt = "Yükle"
        panel.message = "Medya kütüphanesine yüklenecek görsel, video veya PDF dosyalarını seç"
        guard panel.runModal() == .OK, !panel.urls.isEmpty else { return }
        uploadFiles(urls: panel.urls)
    }

    func uploadFiles(urls: [URL]) {
        guard let app, let brandId, !urls.isEmpty else { return }
        Task {
            for url in urls {
                await uploadSingleFile(url: url, app: app, brandId: brandId)
            }
            await load()
        }
    }

    private func uploadSingleFile(url: URL, app: AppModel, brandId: EntityID) async {
        let ext = url.pathExtension.lowercased()
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }

        do {
            let file: UploadFile
            let kind: AssetKind
            var thumb: NSImage?
            if ["png", "jpg", "jpeg", "webp", "gif", "heic", "tiff"].contains(ext) {
                let imported = try ImageImport.from(url: url)
                file = imported.file
                kind = .image
                thumb = imported.thumbnail
            } else if let rule = AssetMimeRules.mediaTypes[ext] {
                let data = try Data(contentsOf: url)
                guard data.count <= rule.maxBytes else {
                    error = "\(url.lastPathComponent) boyut sınırını aşıyor."
                    return
                }
                file = UploadFile(filename: url.lastPathComponent, mimeType: rule.mime, data: data)
                kind = rule.kind
            } else {
                error = "\(url.lastPathComponent) desteklenmeyen bir dosya türü."
                return
            }

            uploadProgress = 0
            let uploaded = try await app.dataService.uploadAsset(file, brandId: brandId, kind: kind) { progress in
                Task { @MainActor in self.uploadProgress = progress }
            }
            uploadProgress = nil
            if let thumb { app.images.seed(thumb, for: uploaded.id) }
            assets.insert(uploaded, at: 0)
            error = nil
        } catch {
            uploadProgress = nil
            self.error = AppModel.describe(error)
        }
    }

    func saveAssetToDisk(_ asset: Asset) {
        guard let app else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = asset.originalFilename ?? "\(asset.id).\(Self.defaultExtension(for: asset.mimeType))"
        guard panel.runModal() == .OK, let dest = panel.url else { return }
        Task {
            do {
                let bytes = try await app.dataService.imageData(assetId: asset.id)
                try bytes.write(to: dest)
            } catch {
                self.error = AppModel.describe(error)
            }
        }
    }

    private static func defaultExtension(for mime: String) -> String {
        switch mime.lowercased() {
        case "application/pdf": "pdf"
        case "video/mp4": "mp4"
        case "video/quicktime": "mov"
        case "image/png": "png"
        default: "jpg"
        }
    }
}

// MARK: - MediaViewController (100% Pure AppKit)

final class MediaViewController: NSViewController {
    private unowned let app: AppModel
    private var model: MediaModel { app.media }

    private let scrollView = NSScrollView()
    private let documentView = FlippedDocumentView()
    private let contentStack = NSStackView()

    private let titleLabel = NSTextField(labelWithString: "Medya Kütüphanesi")
    private let subtitleLabel = NSTextField(labelWithString: "")
    private var filterBar: MediaFilterBarView!
    private var uploadBtn: PillButton!
    private var aiGenBtn: PillButton!
    private let statusRow = NSStackView()
    private let statusLabel = NSTextField(labelWithString: "")
    private let errorBanner = InlineErrorBannerView()
    private let emptyView = NSStackView()
    private var gridView: MediaGridDropContainerView!

    private var observation: ObservationToken?
    private var lastBrandId: EntityID?
    private var renderedAssetIds: [Asset] = []

    init(app: AppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas

        let clip = FlippedClipView()
        clip.drawsBackground = false
        scrollView.contentView = clip
        scrollView.drawsBackground = false
        scrollView.borderType = .noBorder
        scrollView.hasVerticalScroller = true
        scrollView.automaticallyAdjustsContentInsets = true
        scrollView.translatesAutoresizingMaskIntoConstraints = false
        documentView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.documentView = documentView
        scrollView.applyMinimalScroller()

        titleLabel.font = NSFont.systemFont(ofSize: 28, weight: .bold)
        titleLabel.textColor = Theme.textPrimary
        subtitleLabel.font = Theme.captionFont
        subtitleLabel.textColor = Theme.textSecondary

        let titleCol = NSStackView(views: [titleLabel, subtitleLabel])
        titleCol.orientation = .vertical
        titleCol.alignment = .leading
        titleCol.spacing = 4

        uploadBtn = PillButton(title: "Görsel/Video Yükle", kind: .secondary, height: 30) { [weak self] in
            self?.model.pickAndUploadFiles()
        }
        aiGenBtn = PillButton(title: "AI Görsel Üret", kind: .primary, height: 30) { [weak self] in
            guard let self, let brandId = self.app.currentBrandId else { return }
            self.app.aiGeneratorTarget = AIGeneratorTarget(brandId: brandId)
        }

        let headerSpacer = NSView()
        headerSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)

        let topRow = NSStackView(views: [titleCol, headerSpacer, uploadBtn, aiGenBtn])
        topRow.orientation = .horizontal
        topRow.alignment = .centerY
        topRow.spacing = 10

        filterBar = MediaFilterBarView { [weak self] picked in
            self?.model.filter = picked
        }

        statusLabel.font = Theme.captionFont
        statusLabel.textColor = Theme.textSecondary
        statusRow.orientation = .horizontal
        statusRow.alignment = .centerY
        statusRow.spacing = 8
        statusRow.addArrangedSubview(StatusDotView(color: Theme.accent, size: 7))
        statusRow.addArrangedSubview(statusLabel)
        statusRow.isHidden = true

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }

        emptyView.orientation = .vertical
        emptyView.alignment = .centerX
        emptyView.spacing = 8
        emptyView.edgeInsets = NSEdgeInsets(top: 64, left: 0, bottom: 32, right: 0)
        emptyView.addArrangedSubview(NSTextField.styledLabel("Bu filtrede medya öğesi yok.", font: Theme.chatFont, color: Theme.textSecondary))
        emptyView.addArrangedSubview(NSTextField.styledLabel("Dosyaları buraya sürükleyebilir ya da “AI Görsel Üret” ile yeni ürün görseli oluşturabilirsin.", font: Theme.captionFont, color: Theme.textTertiary))
        emptyView.isHidden = true

        gridView = MediaGridDropContainerView(app: app) { [weak self] urls in
            self?.model.uploadFiles(urls: urls)
        }

        contentStack.orientation = .vertical
        contentStack.alignment = .leading
        contentStack.spacing = 22
        contentStack.translatesAutoresizingMaskIntoConstraints = false
        contentStack.addArrangedSubview(topRow)
        contentStack.addArrangedSubview(filterBar)
        contentStack.addArrangedSubview(statusRow)
        contentStack.addArrangedSubview(errorBanner)
        contentStack.addArrangedSubview(emptyView)
        contentStack.addArrangedSubview(gridView)
        documentView.addSubview(contentStack)
        root.addSubview(scrollView)

        let maxW = contentStack.widthAnchor.constraint(equalToConstant: 960)
        maxW.priority = .defaultHigh

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: root.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: root.bottomAnchor),

            documentView.leadingAnchor.constraint(equalTo: clip.leadingAnchor),
            documentView.trailingAnchor.constraint(equalTo: clip.trailingAnchor),
            documentView.topAnchor.constraint(equalTo: clip.topAnchor),

            contentStack.centerXAnchor.constraint(equalTo: documentView.centerXAnchor),
            contentStack.leadingAnchor.constraint(greaterThanOrEqualTo: documentView.leadingAnchor, constant: 64),
            contentStack.trailingAnchor.constraint(lessThanOrEqualTo: documentView.trailingAnchor, constant: -64),
            maxW,
            contentStack.topAnchor.constraint(equalTo: documentView.topAnchor, constant: 28),
            contentStack.bottomAnchor.constraint(equalTo: documentView.bottomAnchor, constant: -56),

            topRow.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            errorBanner.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            emptyView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
            gridView.widthAnchor.constraint(equalTo: contentStack.widthAnchor),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.render()
        }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        Task { await model.load() }
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }

        let brandName = app.brand(app.currentBrandId)?.name ?? "Marka seçilmedi"
        subtitleLabel.stringValue = "\(brandName) · \(model.assets.count) öğe · sürükle-bırak destekli"
        filterBar.update(selected: model.filter, counts: model.counts)

        uploadBtn.showsSpinner = model.uploadProgress != nil
        uploadBtn.isEnabled = app.currentBrandId != nil && model.uploadProgress == nil
        aiGenBtn.isEnabled = app.currentBrandId != nil

        if let p = model.uploadProgress {
            statusRow.isHidden = false
            statusLabel.stringValue = "Dosya yükleniyor… %\(Int(p * 100))"
        } else if let job = model.activeAIJob {
            statusRow.isHidden = false
            statusLabel.stringValue = job.progressMessage ?? "Gemini AI görsel üretiyor…"
        } else {
            statusRow.isHidden = true
        }

        if let err = model.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        let visible = model.visibleAssets
        let showEmpty = visible.isEmpty && !model.isLoading
        emptyView.isHidden = !showEmpty
        gridView.isHidden = showEmpty
        if visible != renderedAssetIds {
            renderedAssetIds = visible
            gridView.setAssets(visible)
        }
    }
}

// MARK: - Filter Bar & Grid Views

private final class MediaFilterBarView: ThemedView {
    private let onSelect: (MediaFilter) -> Void
    private var buttons: [MediaFilter: PillButton] = [:]

    init(onSelect: @escaping (MediaFilter) -> Void) {
        self.onSelect = onSelect
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false

        var views: [NSView] = []
        for f in MediaFilter.allCases {
            let btn = PillButton(title: f.label, kind: .secondary, height: 28) { [weak self] in
                self?.onSelect(f)
            }
            buttons[f] = btn
            views.append(btn)
        }
        let row = NSStackView(views: views)
        row.orientation = .horizontal
        row.spacing = 8
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func update(selected: MediaFilter, counts: [MediaFilter: Int]) {
        for f in MediaFilter.allCases {
            guard let btn = buttons[f] else { continue }
            btn.title = "\(f.label) (\(counts[f] ?? 0))"
            btn.kind = (f == selected) ? .ink : .secondary
        }
    }
}

private final class MediaGridDropContainerView: ThemedView {
    private unowned let app: AppModel
    private let onDropFiles: ([URL]) -> Void
    private var cards: [MediaAssetCardView] = []
    private var lastWidth: CGFloat = 0

    override var isFlipped: Bool { true }

    init(app: AppModel, onDropFiles: @escaping ([URL]) -> Void) {
        self.app = app
        self.onDropFiles = onDropFiles
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        cornerRadius = 16
        registerForDraggedTypes([.fileURL])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func setAssets(_ assets: [Asset]) {
        cards.forEach { $0.removeFromSuperview() }
        cards = assets.map { asset in
            let v = MediaAssetCardView(app: app, asset: asset)
            addSubview(v)
            return v
        }
        needsLayout = true
        invalidateIntrinsicContentSize()
    }

    override func layout() {
        super.layout()
        _ = layoutGrid(in: bounds.width, place: true)
        if abs(bounds.width - lastWidth) > 0.5 {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: NSSize {
        let w = bounds.width > 40 ? bounds.width : 880
        return NSSize(width: NSView.noIntrinsicMetric, height: max(120, layoutGrid(in: w, place: false)))
    }

    private func layoutGrid(in availableWidth: CGFloat, place: Bool) -> CGFloat {
        guard !cards.isEmpty else { return 0 }
        let width = max(200, availableWidth)
        let hSpacing: CGFloat = 18
        let vSpacing: CGFloat = 22
        let minColWidth: CGFloat = 175
        let cols = max(1, Int(floor((width + hSpacing) / (minColWidth + hSpacing))))
        let colWidth = min(240, floor((width - CGFloat(cols - 1) * hSpacing) / CGFloat(cols)))
        let thumbHeight = round(colWidth * 1.1)
        let cellHeight = thumbHeight + 44

        for (i, item) in cards.enumerated() {
            let col = i % cols
            let row = i / cols
            let x = CGFloat(col) * (colWidth + hSpacing)
            let y = CGFloat(row) * (cellHeight + vSpacing)
            if place {
                item.frame = NSRect(x: x, y: y, width: colWidth, height: cellHeight)
                item.layoutCard(thumbHeight: thumbHeight)
            }
        }
        let rows = (cards.count + cols - 1) / cols
        return CGFloat(rows) * cellHeight + CGFloat(max(0, rows - 1)) * vSpacing
    }

    override func draggingEntered(_ sender: any NSDraggingInfo) -> NSDragOperation {
        borderColor = Theme.accent
        borderWidth = 1.5
        return .copy
    }

    override func draggingExited(_ sender: (any NSDraggingInfo)?) {
        borderWidth = 0
    }

    override func draggingEnded(_ sender: any NSDraggingInfo) {
        borderWidth = 0
    }

    override func performDragOperation(_ sender: any NSDraggingInfo) -> Bool {
        borderWidth = 0
        let opts: [NSPasteboard.ReadingOptionKey: Any] = [.urlReadingFileURLsOnly: true]
        guard let urls = sender.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: opts) as? [URL], !urls.isEmpty else {
            return false
        }
        onDropFiles(urls)
        return true
    }
}

private final class MediaAssetCardView: NSView {
    private unowned let app: AppModel
    private let asset: Asset
    private let thumbBox = ThemedView()
    private let metaStack = NSStackView()

    override var isFlipped: Bool { true }

    init(app: AppModel, asset: Asset) {
        self.app = app
        self.asset = asset
        super.init(frame: .zero)

        thumbBox.backgroundColor = Theme.fill
        thumbBox.borderColor = Theme.border
        thumbBox.borderWidth = 1
        thumbBox.cornerRadius = 16
        thumbBox.layer?.masksToBounds = true
        addSubview(thumbBox)

        if asset.kind == .image || asset.kind == .logo {
            let iv = AssetImageView(store: app.images, assetId: asset.id, contentMode: .fill, cornerRadius: 16)
            iv.translatesAutoresizingMaskIntoConstraints = false
            thumbBox.addSubview(iv)
            NSLayoutConstraint.activate([
                iv.leadingAnchor.constraint(equalTo: thumbBox.leadingAnchor),
                iv.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor),
                iv.topAnchor.constraint(equalTo: thumbBox.topAnchor),
                iv.bottomAnchor.constraint(equalTo: thumbBox.bottomAnchor),
            ])
        } else {
            let symbol = switch asset.kind {
            case .video: "play.rectangle.fill"
            case .document: "doc.richtext.fill"
            case .audio: "waveform"
            default: "doc.fill"
            }
            let icon = NSImageView()
            icon.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
                .withSymbolConfiguration(.init(pointSize: 32, weight: .regular))
            icon.contentTintColor = asset.kind == .video ? Theme.accent : Theme.textSecondary
            icon.translatesAutoresizingMaskIntoConstraints = false
            thumbBox.addSubview(icon)
            NSLayoutConstraint.activate([
                icon.centerXAnchor.constraint(equalTo: thumbBox.centerXAnchor),
                icon.centerYAnchor.constraint(equalTo: thumbBox.centerYAnchor),
            ])
        }

        if asset.source == .generated {
            let badge = ThemedView()
            badge.backgroundColor = NSColor.black.withAlphaComponent(0.72)
            badge.cornerRadius = 9
            badge.translatesAutoresizingMaskIntoConstraints = false
            let lbl = NSTextField.styledLabel("AI", font: NSFont.systemFont(ofSize: 10, weight: .bold), color: .white)
            lbl.translatesAutoresizingMaskIntoConstraints = false
            badge.addSubview(lbl)
            thumbBox.addSubview(badge)
            NSLayoutConstraint.activate([
                badge.topAnchor.constraint(equalTo: thumbBox.topAnchor, constant: 8),
                badge.trailingAnchor.constraint(equalTo: thumbBox.trailingAnchor, constant: -8),
                lbl.leadingAnchor.constraint(equalTo: badge.leadingAnchor, constant: 7),
                lbl.trailingAnchor.constraint(equalTo: badge.trailingAnchor, constant: -7),
                lbl.topAnchor.constraint(equalTo: badge.topAnchor, constant: 3),
                lbl.bottomAnchor.constraint(equalTo: badge.bottomAnchor, constant: -3),
            ])
        }

        let name = NSTextField.styledLabel(
            asset.originalFilename ?? asset.id,
            font: NSFont.systemFont(ofSize: 12, weight: .medium),
            color: Theme.textPrimary
        )
        let dims = (asset.width != nil && asset.height != nil) ? "\(asset.width!)×\(asset.height!)" : asset.kind.label
        let kb = max(1, asset.bytes / 1024)
        let sub = NSTextField.styledLabel("\(dims) · \(kb) KB", font: Theme.smallFont, color: Theme.textSecondary)

        metaStack.orientation = .vertical
        metaStack.alignment = .leading
        metaStack.spacing = 2
        metaStack.addArrangedSubview(name)
        metaStack.addArrangedSubview(sub)
        addSubview(metaStack)

        let ctxMenu = NSMenu()
        let saveItem = NSMenuItem(title: "Farklı Kaydet…", action: #selector(saveClicked), keyEquivalent: "")
        saveItem.target = self
        ctxMenu.addItem(saveItem)
        self.menu = ctxMenu
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func layoutCard(thumbHeight: CGFloat) {
        thumbBox.frame = NSRect(x: 0, y: 0, width: bounds.width, height: thumbHeight)
        metaStack.frame = NSRect(x: 2, y: thumbHeight + 6, width: bounds.width - 4, height: 36)
    }

    @objc private func saveClicked() {
        app.media.saveAssetToDisk(asset)
    }
}

// MARK: - AIImageGeneratorSheetController (Gemini AI Görsel Üretimi)

final class AIImageGeneratorSheetController: NSViewController, NSTextViewDelegate {
    private unowned let app: AppModel
    private let target: AIGeneratorTarget
    private let onDone: () -> Void

    private let promptTextView = NSTextView()
    private var ratioControl: NSSegmentedControl!
    private var sizeControl: NSSegmentedControl!
    private let referencePopup = NSPopUpButton()
    private var preserveLabelCheckbox: NSButton!
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private var generateBtn: PillButton!

    private var brandImages: [Asset] = []
    private var selectedRefAssetId: EntityID?
    private var isSubmitting = false

    private static let ratios = [("4:5", "4:5 Post"), ("9:16", "9:16 Hikaye/Reels"), ("1:1", "1:1 Kare")]
    private static let sizes = [("2K", "2K (1856×2304)"), ("1K", "1K")]

    init(app: AppModel, target: AIGeneratorTarget, onDone: @escaping () -> Void) {
        self.app = app
        self.target = target
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let headerTitle = target.targetContentId != nil ? "AI ile Yuvayı Doldur" : "AI Görsel Üret (Gemini)"
        let titleLabel = NSTextField.styledLabel(headerTitle, font: NSFont.systemFont(ofSize: 15, weight: .semibold), color: Theme.textPrimary)
        let topSpacer = NSView()
        topSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let closeBtn = PillButton(title: "Kapat", kind: .secondary, height: 26) { [weak self] in
            self?.closeSheet()
        }
        let headerRow = NSStackView(views: [titleLabel, topSpacer, closeBtn])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        let topHairline = HairlineView()
        topHairline.translatesAutoresizingMaskIntoConstraints = false

        // Prompt editor
        let promptBox = ThemedView()
        promptBox.borderColor = Theme.border
        promptBox.borderWidth = 1
        promptBox.cornerRadius = 12
        promptBox.translatesAutoresizingMaskIntoConstraints = false
        promptBox.heightAnchor.constraint(equalToConstant: 100).isActive = true

        let promptScroll = NSScrollView()
        promptScroll.drawsBackground = false
        promptScroll.borderType = .noBorder
        promptScroll.hasVerticalScroller = true
        promptScroll.translatesAutoresizingMaskIntoConstraints = false
        promptTextView.isRichText = false
        promptTextView.drawsBackground = false
        promptTextView.font = NSFont.systemFont(ofSize: 13)
        promptTextView.textColor = Theme.textPrimary
        promptTextView.string = target.initialPrompt
        promptTextView.delegate = self
        promptTextView.isVerticallyResizable = true
        promptTextView.autoresizingMask = [.width]
        promptTextView.textContainer?.widthTracksTextView = true
        promptScroll.documentView = promptTextView
        promptBox.addSubview(promptScroll)
        NSLayoutConstraint.activate([
            promptScroll.leadingAnchor.constraint(equalTo: promptBox.leadingAnchor, constant: 8),
            promptScroll.trailingAnchor.constraint(equalTo: promptBox.trailingAnchor, constant: -8),
            promptScroll.topAnchor.constraint(equalTo: promptBox.topAnchor, constant: 8),
            promptScroll.bottomAnchor.constraint(equalTo: promptBox.bottomAnchor, constant: -8),
        ])

        ratioControl = NSSegmentedControl(labels: Self.ratios.map(\.1), trackingMode: .selectOne, target: nil, action: nil)
        ratioControl.selectedSegment = 0

        sizeControl = NSSegmentedControl(labels: Self.sizes.map(\.1), trackingMode: .selectOne, target: nil, action: nil)
        sizeControl.selectedSegment = 0

        referencePopup.target = self
        referencePopup.action = #selector(referenceChanged)
        let pickRefFileBtn = PillButton(title: "Dosyadan Seç…", kind: .secondary, height: 24) { [weak self] in
            self?.pickReferenceFromDisk()
        }
        let refRow = NSStackView(views: [referencePopup, pickRefFileBtn])
        refRow.orientation = .horizontal
        refRow.alignment = .centerY
        refRow.spacing = 8

        preserveLabelCheckbox = NSButton(checkboxWithTitle: "Ürün etiketini bozmadan koru", target: nil, action: nil)
        preserveLabelCheckbox.state = .off

        statusLabel.font = Theme.smallFont
        statusLabel.textColor = Theme.textSecondary
        statusLabel.isHidden = true

        let cancelBtn = PillButton(title: "Vazgeç", kind: .secondary, height: 28) { [weak self] in
            self?.closeSheet()
        }
        generateBtn = PillButton(title: "Üret", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.submitGeneration() }
        }
        generateBtn.isEnabled = !target.initialPrompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty

        let actionSpacer = NSView()
        actionSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bottomRow = NSStackView(views: [actionSpacer, cancelBtn, generateBtn])
        bottomRow.orientation = .horizontal
        bottomRow.alignment = .centerY
        bottomRow.spacing = 8

        let formStack = NSStackView(views: [
            NSTextField.styledLabel("Görsel tarifi (Prompt)", font: Theme.captionFont, color: Theme.textSecondary),
            promptBox,
            NSTextField.styledLabel("Oran", font: Theme.captionFont, color: Theme.textSecondary),
            ratioControl,
            NSTextField.styledLabel("Çözünürlük", font: Theme.captionFont, color: Theme.textSecondary),
            sizeControl,
            NSTextField.styledLabel("Referans ürün fotoğrafı (isteğe bağlı)", font: Theme.captionFont, color: Theme.textSecondary),
            refRow,
            preserveLabelCheckbox,
            statusLabel,
            bottomRow,
        ])
        formStack.orientation = .vertical
        formStack.alignment = .leading
        formStack.spacing = 10
        formStack.translatesAutoresizingMaskIntoConstraints = false

        promptBox.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true
        statusLabel.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true
        bottomRow.widthAnchor.constraint(equalTo: formStack.widthAnchor).isActive = true

        root.addSubview(headerRow)
        root.addSubview(topHairline)
        root.addSubview(formStack)

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 520),
            headerRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            headerRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            headerRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),

            topHairline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topHairline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topHairline.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 12),

            formStack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            formStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            formStack.topAnchor.constraint(equalTo: topHairline.bottomAnchor, constant: 16),
            formStack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])

        self.view = root
        rebuildReferenceMenu()
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await loadBrandImages() }
    }

    override func cancelOperation(_ sender: Any?) {
        closeSheet()
    }

    func textDidChange(_ notification: Notification) {
        let hasPrompt = !promptTextView.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        generateBtn.isEnabled = hasPrompt && !isSubmitting
    }

    private func loadBrandImages() async {
        if let loaded = try? await app.dataService.assets(brandId: target.brandId, kind: .image) {
            brandImages = loaded
            rebuildReferenceMenu()
        }
    }

    private func rebuildReferenceMenu() {
        referencePopup.removeAllItems()
        referencePopup.addItem(withTitle: "Referans görsel yok")
        referencePopup.lastItem?.representedObject = nil
        for asset in brandImages {
            let name = asset.originalFilename ?? asset.id
            referencePopup.addItem(withTitle: name)
            referencePopup.lastItem?.representedObject = asset.id
            if asset.id == selectedRefAssetId {
                referencePopup.select(referencePopup.lastItem)
            }
        }
    }

    @objc private func referenceChanged() {
        selectedRefAssetId = referencePopup.selectedItem?.representedObject as? EntityID
        if selectedRefAssetId != nil && preserveLabelCheckbox.state == .off {
            preserveLabelCheckbox.state = .on
        }
    }

    private func pickReferenceFromDisk() {
        guard let url = ImageImport.pick(multiple: false).first else { return }
        Task {
            do {
                let imported = try ImageImport.from(url: url)
                let uploaded = try await app.dataService.uploadImage(imported.file, brandId: target.brandId) { _ in }
                app.images.seed(imported.thumbnail, for: uploaded.id)
                selectedRefAssetId = uploaded.id
                preserveLabelCheckbox.state = .on
                await loadBrandImages()
            } catch {
                statusLabel.stringValue = AppModel.describe(error)
                statusLabel.isHidden = false
            }
        }
    }

    private func submitGeneration() async {
        let prompt = promptTextView.string.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !prompt.isEmpty, !isSubmitting else { return }
        isSubmitting = true
        generateBtn.showsSpinner = true
        generateBtn.isEnabled = false
        defer {
            isSubmitting = false
            generateBtn.showsSpinner = false
            generateBtn.isEnabled = true
        }

        let ratio = Self.ratios[max(0, ratioControl.selectedSegment)].0
        let size = Self.sizes[max(0, sizeControl.selectedSegment)].0
        let refs = selectedRefAssetId.map { [$0] } ?? []
        let preserve = preserveLabelCheckbox.state == .on

        do {
            let job = try await app.dataService.generateAIImage(
                brandId: target.brandId,
                prompt: prompt,
                aspectRatio: ratio,
                imageSize: size,
                referenceAssetIds: refs,
                preserveProductLabel: preserve,
                targetContentId: target.targetContentId,
                targetSlotId: target.targetSlotId
            )
            await app.media.load()
            if let cid = target.targetContentId {
                await app.posts.load()
                if let detail = app.detail, detail.content.id == cid, let fresh = app.posts.card(cid) {
                    await detail.reloadAfterRender(freshCard: fresh)
                }
            }
            if job.status == .succeeded {
                closeSheet()
            } else {
                statusLabel.stringValue = "İş kuyruğa alındı (\(job.id)). Mac worker üretimi tamamlayınca kütüphanede belirecek."
                statusLabel.isHidden = false
                try? await Task.sleep(for: .milliseconds(900))
                closeSheet()
            }
        } catch {
            statusLabel.stringValue = AppModel.describe(error)
            statusLabel.isHidden = false
        }
    }

    private func closeSheet() {
        onDone()
        dismiss(nil)
    }
}
