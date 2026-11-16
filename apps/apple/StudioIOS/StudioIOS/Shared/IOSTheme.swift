import Foundation
import Observation
import StudioKit
import UIKit

// MARK: - Studio iOS Design Tokens (100% Pure UIKit)

enum IOSTheme {
    static let canvas = UIColor(light: 0xFFFFFF, dark: 0x161617)
    static let groupedBackground = UIColor(light: 0xF7F7F8, dark: 0x0E0E10)
    static let fill = UIColor(light: 0xF4F4F5, dark: 0x262628)
    static let fillStrong = UIColor(light: 0xEBEBED, dark: 0x323235)
    static let hairline = UIColor(light: 0xECECEE, dark: 0x2E2E31)
    static let border = UIColor(light: 0xE4E4E7, dark: 0x3A3A3D)

    static let textPrimary = UIColor(light: 0x101010, dark: 0xF2F2F3)
    static let textSecondary = UIColor(light: 0x7C7C82, dark: 0x9C9CA2)
    static let textTertiary = UIColor(light: 0xA6A6AB, dark: 0x6E6E74)

    /// Studio orange (#FF6A00).
    static let accent = UIColor(red: 1.0, green: CGFloat(0x6A) / 255.0, blue: 0.0, alpha: 1.0)
    static let onAccent = UIColor.white
    static let ink = UIColor(light: 0x0A0A0A, dark: 0xF5F5F5)

    static let postDark = UIColor(hex: 0x0A0A0A)
    static let postLight = UIColor(light: 0xFFFFFF, dark: 0xECECEE)
    static let postMuted = UIColor(light: 0xF4F4F5, dark: 0x262628)

    static let cardRadius: CGFloat = 18
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
            let isDark = traits.userInterfaceStyle == .dark
            return UIColor(hex: isDark ? dark : light, alpha: alpha)
        }
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

// MARK: - @Observable Binding for UIKit

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

// MARK: - Reusable UIKit Components

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
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: size),
            heightAnchor.constraint(equalToConstant: size),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

final class IOSCardView: UIView {
    let stack = UIStackView()

    init(padding: CGFloat = 16, spacing: CGFloat = 10) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.canvas
        layer.cornerRadius = IOSTheme.cardRadius
        layer.cornerCurve = .continuous
        layer.borderWidth = 1
        layer.borderColor = IOSTheme.border.cgColor

        stack.axis = .vertical
        stack.alignment = .fill
        stack.spacing = spacing
        stack.translatesAutoresizingMaskIntoConstraints = false
        addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: padding),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -padding),
            stack.topAnchor.constraint(equalTo: topAnchor, constant: padding),
            stack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -padding),
        ])

        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.layer.borderColor = IOSTheme.border.cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

extension UIButton {
    static func studioPill(title: String, primary: Bool = false, action: @escaping () -> Void) -> UIButton {
        var config = primary ? UIButton.Configuration.filled() : UIButton.Configuration.tinted()
        config.title = title
        config.cornerStyle = .capsule
        config.baseBackgroundColor = primary ? IOSTheme.accent : IOSTheme.fill
        config.baseForegroundColor = primary ? IOSTheme.onAccent : IOSTheme.textPrimary
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 14, bottom: 8, trailing: 14)
        config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
            var outgoing = incoming
            outgoing.font = UIFont.systemFont(ofSize: 13, weight: .semibold)
            return outgoing
        }
        let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
        button.translatesAutoresizingMaskIntoConstraints = false
        return button
    }
}

extension UILabel {
    static func studio(_ text: String = "", size: CGFloat = 14, weight: UIFont.Weight = .regular, color: UIColor = IOSTheme.textPrimary, lines: Int = 1) -> UILabel {
        let label = UILabel()
        label.translatesAutoresizingMaskIntoConstraints = false
        label.text = text
        label.font = UIFont.systemFont(ofSize: size, weight: weight)
        label.textColor = color
        label.numberOfLines = lines
        return label
    }
}

// MARK: - Image Store & Import for iOS

@MainActor
@Observable
final class IOSImageStore {
    weak var app: IOSAppModel?
    private(set) var images: [EntityID: UIImage] = [:]
    private(set) var failed: Set<EntityID> = []
    private var loading: Set<EntityID> = []

    func seed(_ image: UIImage, for assetId: EntityID) {
        images[assetId] = image
    }

    func image(_ assetId: EntityID) -> UIImage? {
        images[assetId]
    }

    func load(_ assetId: EntityID) {
        guard images[assetId] == nil, !loading.contains(assetId), !failed.contains(assetId),
              let service = app?.dataService else { return }
        loading.insert(assetId)
        Task {
            defer { loading.remove(assetId) }
            do {
                let data = try await service.imageData(assetId: assetId)
                if let uiImg = UIImage(data: data) {
                    images[assetId] = uiImg
                } else {
                    failed.insert(assetId)
                }
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

final class IOSAssetImageView: UIImageView {
    private weak var store: IOSImageStore?
    private var token: IOSObservationToken?

    var assetId: EntityID? {
        didSet {
            guard assetId != oldValue else { return }
            bind()
        }
    }

    init(store: IOSImageStore?, assetId: EntityID? = nil, cornerRadius: CGFloat = 0) {
        self.store = store
        self.assetId = assetId
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        contentMode = .scaleAspectFill
        clipsToBounds = true
        backgroundColor = IOSTheme.fill
        if cornerRadius > 0 {
            layer.cornerRadius = cornerRadius
            layer.cornerCurve = .continuous
        }
        bind()
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func bind() {
        token?.cancel()
        token = nil
        guard let store, let assetId else {
            image = nil
            return
        }
        store.load(assetId)
        token = observeIOS { [weak self, weak store] in
            guard let self, let store else { return }
            self.image = store.image(assetId)
        }
    }
}

enum IOSImageImport {
    struct Imported {
        var file: UploadFile
        var thumbnail: UIImage
    }

    static func from(image: UIImage, filename: String = "fotograf.jpg") throws -> Imported {
        guard let jpeg = image.jpegData(compressionQuality: 0.88) else {
            throw StudioAPIError.invalidConfiguration("Fotoğraf kodlanamadı.")
        }
        guard jpeg.count <= AssetMimeRules.imageMaxBytes else {
            throw StudioAPIError.invalidConfiguration("Fotoğraf 20 MB sınırını aşıyor.")
        }
        let width = Int(image.size.width * image.scale)
        let height = Int(image.size.height * image.scale)
        let cleanName = filename.lowercased().hasSuffix(".jpg") || filename.lowercased().hasSuffix(".jpeg")
            ? filename
            : "\(filename).jpg"
        let upload = UploadFile(
            filename: cleanName,
            mimeType: "image/jpeg",
            data: jpeg,
            width: width > 0 ? width : nil,
            height: height > 0 ? height : nil
        )
        return Imported(file: upload, thumbnail: image)
    }
}
