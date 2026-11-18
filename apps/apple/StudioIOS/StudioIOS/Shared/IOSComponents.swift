import Photos
import PhotosUI
import StudioKit
import UIKit
import UniformTypeIdentifiers

// MARK: - Views

final class IOSStatusDotView: UIView {
    var dotColor: UIColor {
        didSet { backgroundColor = dotColor }
    }

    init(color: UIColor = IOSTheme.accent, size: CGFloat = 7) {
        self.dotColor = color
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = color
        layer.cornerRadius = size / 2
        isAccessibilityElement = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Continuous-corner card with a hairline border.
final class IOSCardView: UIView {
    let stack = UIStackView()

    init(padding: CGFloat = 16, spacing: CGFloat = 10, background: UIColor = IOSTheme.elevated) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = background
        layer.cornerRadius = IOSTheme.cardRadius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = IOSTheme.border.cgColor

        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: padding, left: padding, bottom: padding, right: padding))

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.layer.borderColor = IOSTheme.border.cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Small ring showing subscription usage (orange from 90 %).
final class UsageRingView: UIView {
    var fraction: Double = 0 { didSet { update() } }
    var ringColor: UIColor = IOSTheme.textSecondary { didSet { update() } }
    private let track = CAShapeLayer()
    private let arc = CAShapeLayer()

    init(size: CGFloat = 13) {
        super.init(frame: CGRect(x: 0, y: 0, width: size, height: size))
        translatesAutoresizingMaskIntoConstraints = false
        for shape in [track, arc] {
            shape.fillColor = UIColor.clear.cgColor
            shape.lineWidth = 2
            layer.addSublayer(shape)
        }
        arc.lineCap = .round
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: size), heightAnchor.constraint(equalToConstant: size)])
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in self.update() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        let rect = bounds.insetBy(dx: 1.5, dy: 1.5)
        track.path = UIBezierPath(ovalIn: rect).cgPath
        let center = CGPoint(x: bounds.midX, y: bounds.midY)
        arc.path = UIBezierPath(arcCenter: center, radius: rect.width / 2, startAngle: -.pi / 2, endAngle: 1.5 * .pi, clockwise: true).cgPath
        update()
    }

    private func update() {
        track.strokeColor = IOSTheme.fillStrong.resolvedColor(with: traitCollection).cgColor
        arc.strokeColor = ringColor.resolvedColor(with: traitCollection).cgColor
        arc.strokeEnd = max(0, min(1, fraction))
    }
}

/// Centered empty / error / not-connected state with an optional action.
final class EmptyStateView: UIView {
    private let iconView = UIImageView()
    private let titleLabel = UILabel.studio("", size: 17, weight: .semibold, lines: 0, style: .headline)
    private let messageLabel = UILabel.studio("", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let buttonRow = UIStackView()

    init() {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.tintColor = IOSTheme.textTertiary
        iconView.contentMode = .scaleAspectFit
        iconView.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 34, weight: .light)
        titleLabel.textAlignment = .center
        messageLabel.textAlignment = .center
        buttonRow.axis = .horizontal
        buttonRow.spacing = 8
        let stack = UIStackView.v([iconView, titleLabel, messageLabel, buttonRow], spacing: 10, alignment: .center)
        stack.setCustomSpacing(16, after: messageLabel)
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(greaterThanOrEqualTo: leadingAnchor, constant: 32),
            stack.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -32),
            stack.centerXAnchor.constraint(equalTo: centerXAnchor),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -20),
            stack.topAnchor.constraint(greaterThanOrEqualTo: topAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(icon: String, title: String, message: String?, actions: [UIButton] = []) {
        iconView.image = UIImage(systemName: icon)
        titleLabel.text = title
        messageLabel.text = message
        messageLabel.isHidden = message?.isEmpty ?? true
        buttonRow.removeAllArranged()
        actions.forEach { buttonRow.addArrangedSubview($0) }
        buttonRow.isHidden = actions.isEmpty
    }
}

/// A short message that slides in at the bottom and leaves by itself.
@MainActor
enum Toast {
    static func show(_ text: String, in view: UIView?, isError: Bool = false) {
        guard let host = view?.window ?? view else { return }
        let label = UILabel.studio(text, size: 14, weight: .medium, color: isError ? IOSTheme.onAccent : IOSTheme.onInk, lines: 3, style: .subheadline)
        label.textAlignment = .center
        let pill = UIView()
        pill.translatesAutoresizingMaskIntoConstraints = false
        pill.backgroundColor = isError ? IOSTheme.accent : IOSTheme.ink
        pill.layer.cornerRadius = 20
        pill.layer.cornerCurve = .continuous
        pill.addSubview(label)
        label.pin(to: pill, insets: UIEdgeInsets(top: 10, left: 16, bottom: 10, right: 16))
        host.addSubview(pill)
        NSLayoutConstraint.activate([
            pill.centerXAnchor.constraint(equalTo: host.centerXAnchor),
            pill.leadingAnchor.constraint(greaterThanOrEqualTo: host.leadingAnchor, constant: 24),
            pill.bottomAnchor.constraint(equalTo: host.safeAreaLayoutGuide.bottomAnchor, constant: -96),
        ])
        pill.alpha = 0
        pill.transform = CGAffineTransform(translationX: 0, y: 12)
        UIAccessibility.post(notification: .announcement, argument: text)
        UIView.animate(withDuration: 0.25) {
            pill.alpha = 1
            pill.transform = .identity
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(2.4))
            UIView.animate(withDuration: 0.25, animations: { pill.alpha = 0 }, completion: { _ in pill.removeFromSuperview() })
        }
    }
}

/// Pinch / double-tap zoomable container for one slide (image + any overlay inside `content`).
final class ZoomableView: UIScrollView, UIScrollViewDelegate {
    let content = UIView()
    var aspect: CGFloat = 4.0 / 5.0 { didSet { setNeedsLayout() } }
    var onZoomChange: ((CGFloat) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        delegate = self
        minimumZoomScale = 1
        maximumZoomScale = 4
        showsHorizontalScrollIndicator = false
        showsVerticalScrollIndicator = false
        bouncesZoom = true
        contentInsetAdjustmentBehavior = .never
        addSubview(content)
        let doubleTap = UITapGestureRecognizer(target: self, action: #selector(doubleTapped(_:)))
        doubleTap.numberOfTapsRequired = 2
        addGestureRecognizer(doubleTap)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard zoomScale == 1, bounds.width > 0 else { return }
        let fit = fittedSize()
        content.frame = CGRect(x: (bounds.width - fit.width) / 2, y: (bounds.height - fit.height) / 2, width: fit.width, height: fit.height)
        contentSize = bounds.size
    }

    private func fittedSize() -> CGSize {
        let width = min(bounds.width, bounds.height * aspect)
        return CGSize(width: width, height: width / aspect)
    }

    func viewForZooming(in scrollView: UIScrollView) -> UIView? { content }

    func scrollViewDidZoom(_ scrollView: UIScrollView) {
        let offsetX = max((bounds.width - contentSize.width) / 2, 0)
        let offsetY = max((bounds.height - contentSize.height) / 2, 0)
        content.center = CGPoint(x: contentSize.width / 2 + offsetX, y: contentSize.height / 2 + offsetY)
        onZoomChange?(zoomScale)
    }

    @objc private func doubleTapped(_ gesture: UITapGestureRecognizer) {
        if zoomScale > 1.01 {
            setZoomScale(1, animated: true)
        } else {
            let point = gesture.location(in: content)
            let size = CGSize(width: bounds.width / 2.5, height: bounds.height / 2.5)
            zoom(to: CGRect(x: point.x - size.width / 2, y: point.y - size.height / 2, width: size.width, height: size.height), animated: true)
        }
    }
}

// MARK: - Picking images (Photos, camera, paste)

/// Presents the photo library or the camera and hands back `UIImage`s.
@MainActor
final class ImagePicking: NSObject, PHPickerViewControllerDelegate, UIImagePickerControllerDelegate, UINavigationControllerDelegate, UIDocumentPickerDelegate {
    private var onPick: (([UIImage]) -> Void)?
    private var retainSelf: ImagePicking?
    /// Where a failed pick is reported (a picture that could not be read is never dropped silently).
    private weak var presenter: UIViewController?

    static func photos(from presenter: UIViewController, limit: Int = 1, onPick: @escaping ([UIImage]) -> Void) {
        var config = PHPickerConfiguration(photoLibrary: .shared())
        config.filter = .images
        config.selectionLimit = limit
        config.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: config)
        let handler = ImagePicking()
        handler.onPick = onPick
        handler.retainSelf = handler
        handler.presenter = presenter
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    static var cameraAvailable: Bool { UIImagePickerController.isSourceTypeAvailable(.camera) }

    static func camera(from presenter: UIViewController, onPick: @escaping ([UIImage]) -> Void) {
        guard cameraAvailable else {
            presenter.presentError("Bu cihazda kamera yok.")
            return
        }
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        let handler = ImagePicking()
        handler.onPick = onPick
        handler.retainSelf = handler
        handler.presenter = presenter
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    /// Image files from the Files app (iCloud Drive, On My iPhone, connected drives).
    static func files(from presenter: UIViewController, limit: Int = 10, onPick: @escaping ([UIImage]) -> Void) {
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image], asCopy: true)
        picker.allowsMultipleSelection = limit > 1
        let handler = ImagePicking()
        handler.onPick = { images in onPick(Array(images.prefix(limit))) }
        handler.retainSelf = handler
        handler.presenter = presenter
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    /// Images on the clipboard, if any.
    static func pastedImages() -> [UIImage] {
        let board = UIPasteboard.general
        guard board.hasImages else { return [] }
        return board.images ?? []
    }

    /// Why a picked item gave no picture.
    enum Failure: Error, Equatable {
        /// Could not be read (an iCloud original that did not download, a broken file).
        case unreadable
        /// Not a picture this device can open.
        case unsupported
    }

    /// The message for picks that failed (nil when none did).
    static func failureMessage(_ failures: [Failure], picked: Int) -> String? {
        guard !failures.isEmpty else { return nil }
        let unreadable = failures.filter { $0 == .unreadable }.count
        let unsupported = failures.count - unreadable
        var lines: [String] = []
        if unreadable > 0 {
            let what = picked == 1 ? "Fotoğraf" : "\(unreadable) fotoğraf"
            lines.append("\(what) alınamadı. Asıl dosya iCloud'da olabilir; internet bağlantını kontrol edip yeniden dene.")
        }
        if unsupported > 0 {
            let what = picked == 1 ? "Seçilen dosya" : "\(unsupported) dosya"
            lines.append("\(what) fotoğraf olarak açılamadı (desteklenmeyen biçim).")
        }
        return lines.joined(separator: "\n")
    }

    /// Hand back what was read and report what was not.
    private static func finish(_ images: [UIImage], failures: [Failure], picked: Int, onPick: (([UIImage]) -> Void)?, presenter: UIViewController?) {
        if !images.isEmpty { onPick?(images) }
        if let message = failureMessage(failures, picked: picked) {
            (presenter?.presentedViewController == nil ? presenter : presenter?.presentedViewController)?.presentError(message, title: "Fotoğraf eklenemedi")
        }
    }

    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        nonisolated(unsafe) let providers = results.map(\.itemProvider)
        MainActor.assumeIsolated {
            let callback = onPick
            let presenter = presenter
            retainSelf = nil
            picker.dismiss(animated: true) {
                guard !providers.isEmpty else { return }
                Task { @MainActor in
                    var images: [UIImage] = []
                    var failures: [Failure] = []
                    for provider in providers {
                        switch await Self.load(provider) {
                        case .success(let image): images.append(image)
                        case .failure(let failure): failures.append(failure)
                        }
                    }
                    Self.finish(images, failures: failures, picked: providers.count, onPick: callback, presenter: presenter)
                }
            }
        }
    }

    private static func load(_ provider: NSItemProvider) async -> Result<UIImage, Failure> {
        guard provider.canLoadObject(ofClass: UIImage.self) else { return .failure(.unsupported) }
        return await withCheckedContinuation { continuation in
            provider.loadObject(ofClass: UIImage.self) { object, error in
                if let image = object as? UIImage {
                    continuation.resume(returning: .success(image))
                } else {
                    continuation.resume(returning: .failure(error == nil ? .unsupported : .unreadable))
                }
            }
        }
    }

    nonisolated func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        let image = info[.originalImage] as? UIImage
        MainActor.assumeIsolated {
            let callback = onPick
            let presenter = presenter
            retainSelf = nil
            picker.dismiss(animated: true) {
                Self.finish(image.map { [$0] } ?? [], failures: image == nil ? [.unreadable] : [], picked: 1, onPick: callback, presenter: presenter)
            }
        }
    }

    nonisolated func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            retainSelf = nil
        }
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated {
            let callback = onPick
            let presenter = presenter
            retainSelf = nil
            Task { @MainActor in
                var images: [UIImage] = []
                var failures: [Failure] = []
                for url in urls {
                    switch await Self.loadFile(url) {
                    case .success(let image): images.append(image)
                    case .failure(let failure): failures.append(failure)
                    }
                }
                Self.finish(images, failures: failures, picked: urls.count, onPick: callback, presenter: presenter)
            }
        }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { retainSelf = nil }
    }

    /// Read a picked file off the main thread (copies may sit on slow storage).
    nonisolated private static func loadFile(_ url: URL) async -> Result<UIImage, Failure> {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else { return .failure(.unreadable) }
        guard let image = UIImage(data: data) else { return .failure(.unsupported) }
        return .success(image)
    }
}

// MARK: - Sharing and saving

@MainActor
enum FileSharing {
    /// Write exported files to a fresh temporary folder.
    static func write(_ files: [ExportedFile]) throws -> [URL] {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("studio-share-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        return try files.map { file in
            let url = folder.appendingPathComponent(file.filename)
            try file.data.write(to: url, options: .atomic)
            return url
        }
    }

    static func share(_ items: [Any], from presenter: UIViewController, source: UIView? = nil, barItem: UIBarButtonItem? = nil) {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        if let popover = controller.popoverPresentationController {
            if let barItem { popover.barButtonItem = barItem } else {
                popover.sourceView = source ?? presenter.view
                popover.sourceRect = source?.bounds ?? CGRect(x: presenter.view.bounds.midX, y: presenter.view.bounds.midY, width: 1, height: 1)
            }
        }
        presenter.present(controller, animated: true)
    }

    /// Save images to the photo library (add-only permission). Returns how many were saved.
    static func saveToPhotos(_ files: [ExportedFile]) async throws -> Int {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw StudioAPIError.invalidConfiguration("Fotoğraflar'a kaydetmek için izin gerekiyor (Ayarlar → Studio → Fotoğraflar).")
        }
        let images = files.filter { ["jpg", "jpeg", "png"].contains(($0.filename as NSString).pathExtension.lowercased()) }
        try await PHPhotoLibrary.shared().performChanges {
            for file in images {
                let request = PHAssetCreationRequest.forAsset()
                let options = PHAssetResourceCreationOptions()
                options.originalFilename = file.filename
                request.addResource(with: .photo, data: file.data, options: options)
            }
        }
        return images.count
    }
}
