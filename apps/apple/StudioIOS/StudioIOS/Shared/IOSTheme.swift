import Foundation
import Observation
import StudioKit
import UIKit

// MARK: - Studio iOS design tokens (black / white / grey; orange only for the primary action and "waiting on you")

enum IOSTheme {
    static let canvas = UIColor(light: 0xFFFFFF, dark: 0x161617)
    /// The drawer under the chat card: a step darker than the chat (lighter grey in light mode).
    static let drawer = UIColor(light: 0xF2F2F3, dark: 0x0A0A0B)
    static let groupedBackground = UIColor(light: 0xF5F5F6, dark: 0x0E0E10)
    static let elevated = UIColor(light: 0xFFFFFF, dark: 0x1E1E20)
    static let fill = UIColor(light: 0xF2F2F3, dark: 0x262628)
    static let fillStrong = UIColor(light: 0xE6E6E8, dark: 0x323235)
    static let hairline = UIColor(light: 0xECECEE, dark: 0x2E2E31)
    static let border = UIColor(light: 0xE4E4E7, dark: 0x3A3A3D)

    static let textPrimary = UIColor(light: 0x101010, dark: 0xF2F2F3)
    static let textSecondary = UIColor(light: 0x737379, dark: 0x9C9CA2)
    static let textTertiary = UIColor(light: 0xA6A6AB, dark: 0x6E6E74)

    /// Studio orange (#FF6A00).
    static let accent = UIColor(red: 1.0, green: CGFloat(0x6A) / 255.0, blue: 0.0, alpha: 1.0)
    static let onAccent = UIColor.white
    /// Black in light mode, white in dark mode (secondary emphasis, selection).
    static let ink = UIColor(light: 0x0A0A0A, dark: 0xF5F5F5)
    static let onInk = UIColor(light: 0xFFFFFF, dark: 0x0A0A0A)

    static let postDark = UIColor(hex: 0x0A0A0A)
    static let postLight = UIColor(light: 0xFFFFFF, dark: 0xECECEE)
    static let postMuted = UIColor(light: 0xF2F2F3, dark: 0x262628)

    static let cardRadius: CGFloat = 20
    static let gutter: CGFloat = 16

    /// Dims the chat while the drawer is open.
    static let scrim = UIColor { traits in
        UIColor.black.withAlphaComponent(traits.userInterfaceStyle == .dark ? 0.45 : 0.14)
    }

    /// A system font that follows Dynamic Type (scaled from `size` at the default size).
    static func font(_ size: CGFloat, _ weight: UIFont.Weight = .regular, style: UIFont.TextStyle = .body) -> UIFont {
        UIFontMetrics(forTextStyle: style).scaledFont(for: .systemFont(ofSize: size, weight: weight))
    }

    /// New York (the system serif) that follows Dynamic Type: the drawer title, the greeting
    /// and assistant replies. Everything else stays SF.
    static func serif(_ size: CGFloat, _ weight: UIFont.Weight = .regular, style: UIFont.TextStyle = .body) -> UIFont {
        let base = UIFont.systemFont(ofSize: size, weight: weight)
        let serif = base.fontDescriptor.withDesign(.serif).map { UIFont(descriptor: $0, size: size) } ?? base
        return UIFontMetrics(forTextStyle: style).scaledFont(for: serif)
    }

    static func monoDigits(_ size: CGFloat, _ weight: UIFont.Weight = .regular) -> UIFont {
        UIFontMetrics(forTextStyle: .caption1).scaledFont(for: .monospacedDigitSystemFont(ofSize: size, weight: weight))
    }
}

extension UIColor {
    convenience init(hex: UInt32, alpha: CGFloat = 1.0) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255.0,
            green: CGFloat((hex >> 8) & 0xFF) / 255.0,
            blue: CGFloat(hex & 0xFF) / 255.0,
            alpha: alpha
        )
    }

    convenience init(light: UInt32, dark: UInt32, alpha: CGFloat = 1.0) {
        self.init { traits in
            UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light, alpha: alpha)
        }
    }

    /// `#RRGGBB` (brand palettes).
    convenience init?(hexString: String) {
        var raw = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if raw.hasPrefix("#") { raw.removeFirst() }
        guard raw.count == 6, let value = UInt32(raw, radix: 16) else { return nil }
        self.init(hex: value)
    }
}

extension StatusTone {
    var uiColor: UIColor {
        switch self {
        case .attention: IOSTheme.accent
        case .primary: IOSTheme.ink
        case .muted: IOSTheme.textTertiary
        }
    }
}

enum IOSAppearancePreference: String, CaseIterable, Sendable {
    case system
    case light
    case dark

    var label: String {
        switch self {
        case .system: "Sistem"
        case .light: "Açık"
        case .dark: "Koyu"
        }
    }

    var interfaceStyle: UIUserInterfaceStyle {
        switch self {
        case .system: .unspecified
        case .light: .light
        case .dark: .dark
        }
    }
}

// MARK: - @Observable binding for UIKit

/// Runs `apply` now and again (on the next main-actor turn) whenever an observed value it read changes.
@MainActor
final class IOSObservationToken {
    private var cancelled = false
    private var scheduled = false
    private var applyBlock: (@MainActor () -> Void)?

    init(_ apply: @escaping @MainActor () -> Void) {
        self.applyBlock = apply
        run()
    }

    private func run() {
        guard !cancelled, let apply = applyBlock else { return }
        scheduled = false
        withObservationTracking {
            apply()
        } onChange: { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.cancelled, !self.scheduled else { return }
                self.scheduled = true
                await Task.yield()
                self.run()
            }
        }
    }

    func cancel() {
        cancelled = true
        applyBlock = nil
    }
}

@MainActor
func observeIOS(_ apply: @escaping @MainActor () -> Void) -> IOSObservationToken {
    IOSObservationToken(apply)
}

// MARK: - Small factories

extension UIButton {
    enum PillKind { case primary, secondary, ink, plain }

    /// Capsule button: `primary` is the orange action, `secondary` a grey fill, `ink` black/white.
    static func studioPill(title: String, kind: PillKind = .secondary, image: String? = nil, action: @escaping () -> Void) -> UIButton {
        let button = UIButton(configuration: pillConfiguration(title: title, kind: kind, image: image), primaryAction: UIAction { _ in action() })
        button.translatesAutoresizingMaskIntoConstraints = false
        button.setContentCompressionResistancePriority(.required, for: .horizontal)
        return button
    }

    static func studioPill(title: String, primary: Bool, action: @escaping () -> Void) -> UIButton {
        studioPill(title: title, kind: primary ? .primary : .secondary, action: action)
    }

    static func pillConfiguration(title: String, kind: PillKind, image: String? = nil) -> UIButton.Configuration {
        var config: UIButton.Configuration = kind == .plain ? .plain() : .filled()
        config.title = title
        config.cornerStyle = .capsule
        switch kind {
        case .primary:
            config.baseBackgroundColor = IOSTheme.accent
            config.baseForegroundColor = IOSTheme.onAccent
        case .secondary:
            config.baseBackgroundColor = IOSTheme.fill
            config.baseForegroundColor = IOSTheme.textPrimary
        case .ink:
            config.baseBackgroundColor = IOSTheme.ink
            config.baseForegroundColor = IOSTheme.onInk
        case .plain:
            config.baseForegroundColor = IOSTheme.textPrimary
        }
        if let image {
            config.image = UIImage(systemName: image, withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
            config.imagePadding = 6
        }
        config.contentInsets = NSDirectionalEdgeInsets(top: 9, leading: 15, bottom: 9, trailing: 15)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = IOSTheme.font(14, .semibold, style: .callout)
            return outgoing
        }
        config.titleLineBreakMode = .byTruncatingTail
        return config
    }

    /// Re-style an existing pill (busy state, title change).
    func setPill(title: String, kind: PillKind, busy: Bool = false, image: String? = nil) {
        var config = UIButton.pillConfiguration(title: title, kind: kind, image: image)
        config.showsActivityIndicator = busy
        configuration = config
    }

    /// A round icon button (36 pt) with an accessibility label.
    static func studioIcon(_ systemName: String, label: String, size: CGFloat = 16, tint: UIColor = IOSTheme.textPrimary, action: (() -> Void)? = nil) -> UIButton {
        var config = UIButton.Configuration.plain()
        config.image = UIImage(systemName: systemName, withConfiguration: UIImage.SymbolConfiguration(pointSize: size, weight: .medium))
        config.baseForegroundColor = tint
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
        let button = action.map { handler in UIButton(configuration: config, primaryAction: UIAction { _ in handler() }) } ?? UIButton(configuration: config)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.accessibilityLabel = label
        NSLayoutConstraint.activate([
            button.widthAnchor.constraint(greaterThanOrEqualToConstant: 36),
            button.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        ])
        return button
    }
}

extension UILabel {
    static func studio(_ text: String = "", size: CGFloat = 15, weight: UIFont.Weight = .regular, color: UIColor = IOSTheme.textPrimary, lines: Int = 1, style: UIFont.TextStyle = .body) -> UILabel {
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = text
        label.font = IOSTheme.font(size, weight, style: style)
        label.adjustsFontForContentSizeCategory = true
        label.textColor = color
        label.numberOfLines = lines
        return label
    }
}

extension UIStackView {
    static func h(_ views: [UIView], spacing: CGFloat = 8, alignment: Alignment = .center) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .horizontal
        stack.spacing = spacing
        stack.alignment = alignment
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    static func v(_ views: [UIView], spacing: CGFloat = 8, alignment: Alignment = .fill) -> UIStackView {
        let stack = UIStackView(arrangedSubviews: views)
        stack.axis = .vertical
        stack.spacing = spacing
        stack.alignment = alignment
        stack.translatesAutoresizingMaskIntoConstraints = false
        return stack
    }

    func removeAllArranged() {
        for view in arrangedSubviews {
            removeArrangedSubview(view)
            view.removeFromSuperview()
        }
    }
}

extension UIView {
    /// Flexible spacer for stack views.
    static func spacer() -> UIView {
        let view = UIView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.setContentHuggingPriority(.init(1), for: .horizontal)
        view.setContentHuggingPriority(.init(1), for: .vertical)
        view.setContentCompressionResistancePriority(.init(1), for: .horizontal)
        // Zero size unless the stack stretches it: no ambiguous height in a centered row.
        let width = view.widthAnchor.constraint(equalToConstant: 0)
        width.priority = .fittingSizeLevel
        let height = view.heightAnchor.constraint(equalToConstant: 0)
        height.priority = .fittingSizeLevel
        NSLayoutConstraint.activate([width, height])
        return view
    }

    func pin(to other: UIView, insets: UIEdgeInsets = .zero) {
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            leadingAnchor.constraint(equalTo: other.leadingAnchor, constant: insets.left),
            trailingAnchor.constraint(equalTo: other.trailingAnchor, constant: -insets.right),
            topAnchor.constraint(equalTo: other.topAnchor, constant: insets.top),
            bottomAnchor.constraint(equalTo: other.bottomAnchor, constant: -insets.bottom),
        ])
    }

    /// Nearest view controller up the responder chain.
    var owningViewController: UIViewController? {
        var responder: UIResponder? = next
        while let current = responder {
            if let vc = current as? UIViewController { return vc }
            responder = current.next
        }
        return nil
    }
}

enum Haptics {
    @MainActor static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    @MainActor static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
    @MainActor static func error() { UINotificationFeedbackGenerator().notificationOccurred(.error) }
    @MainActor static func tap() { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    @MainActor static func selection() { UISelectionFeedbackGenerator().selectionChanged() }
}

extension UIViewController {
    func presentError(_ message: String, title: String = "Olmadı") {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Tamam", style: .default))
        present(alert, animated: true)
    }

    /// Confirmation with a destructive button.
    func confirm(_ title: String, message: String? = nil, action: String, destructive: Bool = true, source: UIView? = nil, onConfirm: @escaping () -> Void) {
        let sheet = UIAlertController(title: title, message: message, preferredStyle: source == nil ? .alert : .actionSheet)
        sheet.addAction(UIAlertAction(title: action, style: destructive ? .destructive : .default) { _ in onConfirm() })
        sheet.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        if let source, let popover = sheet.popoverPresentationController {
            popover.sourceView = source
            popover.sourceRect = source.bounds
        }
        present(sheet, animated: true)
    }

    /// One-field prompt (rename, URL).
    func prompt(_ title: String, message: String? = nil, text: String?, placeholder: String? = nil, action: String = "Kaydet", keyboard: UIKeyboardType = .default, onSave: @escaping (String) -> Void) {
        let alert = UIAlertController(title: title, message: message, preferredStyle: .alert)
        alert.addTextField { field in
            field.text = text
            field.placeholder = placeholder
            field.keyboardType = keyboard
            field.clearButtonMode = .whileEditing
            if keyboard == .URL {
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
            }
        }
        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        alert.addAction(UIAlertAction(title: action, style: .default) { [weak alert] _ in
            onSave(alert?.textFields?.first?.text ?? "")
        })
        present(alert, animated: true)
    }

    /// Present as a sheet with detents and a grabber.
    func presentSheet(_ controller: UIViewController, detents: [UISheetPresentationController.Detent] = [.medium(), .large()], wrap: Bool = true) {
        let presented = wrap ? UINavigationController(rootViewController: controller) : controller
        if let sheet = presented.sheetPresentationController {
            sheet.detents = detents
            sheet.prefersGrabberVisible = true
            sheet.preferredCornerRadius = 24
            sheet.prefersScrollingExpandsWhenScrolledToEdge = true
        }
        present(presented, animated: true)
    }
}

// MARK: - Images

@MainActor
@Observable
final class IOSImageStore {
    weak var app: IOSAppModel?
    private(set) var images: [EntityID: UIImage] = [:]
    private(set) var failed: Set<EntityID> = []
    @ObservationIgnored private var loading: Set<EntityID> = []

    func seed(_ image: UIImage, for assetId: EntityID) {
        images[assetId] = image
        failed.remove(assetId)
    }

    func image(_ assetId: EntityID) -> UIImage? { images[assetId] }

    func load(_ assetId: EntityID) {
        guard images[assetId] == nil, !loading.contains(assetId), !failed.contains(assetId),
              let service = app?.dataService else { return }
        loading.insert(assetId)
        Task {
            defer { loading.remove(assetId) }
            do {
                let data = try await service.imageData(assetId: assetId)
                if let image = await Self.decode(data) {
                    images[assetId] = image
                } else {
                    failed.insert(assetId)
                }
            } catch {
                failed.insert(assetId)
            }
        }
    }

    /// Full-size bytes for sharing / saving.
    func data(_ assetId: EntityID) async -> Data? {
        try? await app?.dataService.imageData(assetId: assetId)
    }

    /// Retry images that failed (e.g. after reconnecting).
    func retryFailed() { failed = [] }

    func clear() {
        images = [:]
        failed = []
    }

    nonisolated private static func decode(_ data: Data) async -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        return await image.byPreparingForDisplay() ?? image
    }
}

final class IOSAssetImageView: UIImageView {
    weak var store: IOSImageStore? {
        didSet { if store !== oldValue { bind() } }
    }
    private var token: IOSObservationToken?
    private let spinner = UIActivityIndicatorView(style: .medium)

    var assetId: EntityID? {
        didSet {
            guard assetId != oldValue else { return }
            bind()
        }
    }

    init(store: IOSImageStore?, assetId: EntityID? = nil, cornerRadius: CGFloat = 0, contentMode: UIView.ContentMode = .scaleAspectFill) {
        self.store = store
        self.assetId = assetId
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        self.contentMode = contentMode
        clipsToBounds = true
        backgroundColor = IOSTheme.fill
        if cornerRadius > 0 {
            layer.cornerRadius = cornerRadius
            layer.cornerCurve = .continuous
        }
        spinner.translatesAutoresizingMaskIntoConstraints = false
        spinner.hidesWhenStopped = true
        addSubview(spinner)
        NSLayoutConstraint.activate([
            spinner.centerXAnchor.constraint(equalTo: centerXAnchor),
            spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        bind()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func bind() {
        token?.cancel()
        token = nil
        guard let store, let assetId else {
            image = nil
            spinner.stopAnimating()
            return
        }
        store.load(assetId)
        token = observeIOS { [weak self, weak store] in
            guard let self, let store else { return }
            let loaded = store.image(assetId)
            self.image = loaded
            if loaded == nil && !store.failed.contains(assetId) { self.spinner.startAnimating() } else { self.spinner.stopAnimating() }
        }
    }
}

enum IOSImageImport {
    struct Imported {
        var file: UploadFile
        var thumbnail: UIImage
    }

    /// Longest side sent to the Mac (keeps uploads fast on cellular; renders use 1080–2160 px).
    static let maxPixel: CGFloat = 3072

    /// A picture as it goes to the Mac: a picture with transparency (a PNG product shot on a
    /// clear background) stays PNG with its alpha; anything else (camera, HEIC, JPEG) becomes JPEG.
    static func from(image: UIImage, filename: String = "fotograf.jpg") throws -> Imported {
        let base = (filename as NSString).deletingPathExtension
        let name = base.isEmpty ? "fotograf" : base
        if hasAlpha(image) {
            // PNG is lossless and larger: step the size down until it fits the upload limit.
            for side in [maxPixel, 2048, 1536] {
                let prepared = downscaled(image, maxPixel: side, opaque: false)
                guard let png = prepared.pngData() else { break }
                if png.count <= AssetMimeRules.imageMaxBytes {
                    return imported(prepared, data: png, filename: "\(name).png", mimeType: "image/png")
                }
            }
            throw StudioAPIError.invalidConfiguration("Saydam fotoğraf 20 MB sınırına sığmıyor.")
        }
        let prepared = downscaled(image, maxPixel: maxPixel, opaque: true)
        guard let jpeg = prepared.jpegData(compressionQuality: 0.88) else {
            throw StudioAPIError.invalidConfiguration("Fotoğraf kodlanamadı.")
        }
        guard jpeg.count <= AssetMimeRules.imageMaxBytes else {
            throw StudioAPIError.invalidConfiguration("Fotoğraf 20 MB sınırını aşıyor.")
        }
        return imported(prepared, data: jpeg, filename: "\(name).jpg", mimeType: "image/jpeg")
    }

    private static func imported(_ prepared: UIImage, data: Data, filename: String, mimeType: String) -> Imported {
        let width = Int(prepared.size.width * prepared.scale)
        let height = Int(prepared.size.height * prepared.scale)
        let upload = UploadFile(
            filename: filename, mimeType: mimeType, data: data,
            width: width > 0 ? width : nil, height: height > 0 ? height : nil)
        return Imported(file: upload, thumbnail: thumbnail(prepared))
    }

    /// The picture carries an alpha channel (PNG, some HEIC); camera photos and JPEGs do not.
    static func hasAlpha(_ image: UIImage) -> Bool {
        guard let cg = image.cgImage else { return false }
        return hasAlpha(cg.alphaInfo)
    }

    static func hasAlpha(_ info: CGImageAlphaInfo) -> Bool {
        switch info {
        case .none, .noneSkipFirst, .noneSkipLast: false
        default: true
        }
    }

    static func downscaled(_ image: UIImage, maxPixel: CGFloat = maxPixel, opaque: Bool = true) -> UIImage {
        let pixelW = image.size.width * image.scale
        let pixelH = image.size.height * image.scale
        let longest = max(pixelW, pixelH)
        guard longest > maxPixel, longest > 0 else { return normalized(image, opaque: opaque) }
        let factor = maxPixel / longest
        let size = CGSize(width: (pixelW * factor).rounded(), height: (pixelH * factor).rounded())
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = 1
        format.opaque = opaque
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
    }

    /// Camera photos carry an orientation flag; draw them upright (keeping alpha unless `opaque`).
    static func normalized(_ image: UIImage, opaque: Bool = true) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat.default()
        format.scale = image.scale
        format.opaque = opaque
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: image.size)) }
    }

    static func thumbnail(_ image: UIImage, side: CGFloat = 240) -> UIImage {
        image.preparingThumbnail(of: CGSize(width: side, height: side * image.size.height / max(image.size.width, 1))) ?? image
    }
}
