import StudioKit
import UIKit

// Building blocks of the Markalar screens, in the app's own language: no bordered boxes, sections
// parted by hairlines, round marks and swatches, pills for actions.

// MARK: - Brand mark

/// The brand's round mark: its logo on white (a logo is drawn for a light background), else its
/// initials on the brand colour, like the avatar of the Profil screen.
final class BrandMarkView: UIView {
    private let logo: IOSAssetImageView
    private let initials = UILabel()
    private let side: CGFloat

    init(side: CGFloat, images: IOSImageStore?) {
        self.side = side
        logo = IOSAssetImageView(store: images, cornerRadius: 0, contentMode: .scaleAspectFit, displayWidth: side)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        layer.cornerRadius = side / 2
        layer.cornerCurve = .circular
        clipsToBounds = true
        logo.backgroundColor = .clear
        addSubview(logo)
        initials.translatesAutoresizingMaskIntoConstraints = false
        initials.font = .systemFont(ofSize: side * 0.38, weight: .bold)
        initials.textAlignment = .center
        initials.adjustsFontSizeToFitWidth = true
        initials.minimumScaleFactor = 0.6
        addSubview(initials)
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: side),
            heightAnchor.constraint(equalToConstant: side),
            logo.centerXAnchor.constraint(equalTo: centerXAnchor),
            logo.centerYAnchor.constraint(equalTo: centerYAnchor),
            logo.widthAnchor.constraint(equalTo: widthAnchor, multiplier: 0.7),
            logo.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.7),
            initials.leadingAnchor.constraint(equalTo: leadingAnchor, constant: side * 0.12),
            initials.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -side * 0.12),
            initials.centerYAnchor.constraint(equalTo: centerYAnchor),
        ])
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ overview: BrandOverview) {
        if let id = overview.logoAssetId {
            logo.assetId = id
            logo.isHidden = false
            initials.isHidden = true
            backgroundColor = .white
            layer.borderWidth = 1 / UITraitCollection.current.displayScale
            layer.borderColor = IOSTheme.border.cgColor
        } else {
            logo.isHidden = true
            initials.isHidden = false
            initials.text = overview.initials
            let color = overview.swatches.first.flatMap { UIColor(hexString: $0.hex) } ?? IOSTheme.accent
            backgroundColor = color
            initials.textColor = Self.readable(on: color)
            layer.borderWidth = 0
        }
    }

    /// Black or white, whichever reads on `color`.
    static func readable(on color: UIColor) -> UIColor {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.resolvedColor(with: .current).getRed(&r, green: &g, blue: &b, alpha: &a)
        return 0.299 * r + 0.587 * g + 0.114 * b > 0.62 ? .black : .white
    }
}

// MARK: - Sections and rows

@MainActor
enum BrandUI {
    static func hairline(inset: CGFloat = 0) -> UIView {
        let holder = UIView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        let line = UIView()
        line.translatesAutoresizingMaskIntoConstraints = false
        line.backgroundColor = IOSTheme.hairline
        holder.addSubview(line)
        NSLayoutConstraint.activate([
            holder.heightAnchor.constraint(equalToConstant: 1 / UITraitCollection.current.displayScale),
            line.topAnchor.constraint(equalTo: holder.topAnchor),
            line.bottomAnchor.constraint(equalTo: holder.bottomAnchor),
            line.leadingAnchor.constraint(equalTo: holder.leadingAnchor, constant: inset),
            line.trailingAnchor.constraint(equalTo: holder.trailingAnchor),
        ])
        return holder
    }

    static func footnote(_ text: String, color: UIColor = IOSTheme.textSecondary) -> UILabel {
        UILabel.studio(text, size: 13, color: color, lines: 0, style: .footnote)
    }

    /// Content inset by the page's gutter.
    static func inset(_ view: UIView, top: CGFloat = 0, bottom: CGFloat = 0, sides: CGFloat = IOSTheme.gutter) -> UIView {
        let holder = UIView()
        holder.translatesAutoresizingMaskIntoConstraints = false
        holder.addSubview(view)
        view.pin(to: holder, insets: UIEdgeInsets(top: top, left: sides, bottom: bottom, right: sides))
        return holder
    }

    /// A section heading: title, an optional line under it and an action at the right.
    static func header(_ title: String, detail: String? = nil, action: UIView? = nil) -> UIView {
        let titleLabel = UILabel.studio(title, size: 17, weight: .semibold, lines: 0, style: .headline)
        titleLabel.accessibilityTraits = .header
        var column: [UIView] = [titleLabel]
        if let detail, !detail.isEmpty { column.append(footnote(detail)) }
        let texts = UIStackView.v(column, spacing: 3)
        var row: [UIView] = [texts]
        if let action {
            action.setContentCompressionResistancePriority(.required, for: .horizontal)
            action.setContentHuggingPriority(.required, for: .horizontal)
            row.append(action)
        }
        return UIStackView.h(row, spacing: 12, alignment: .top)
    }

    /// A small pill for a section's action ("Ekle", "AI ile çıkar").
    static func smallPill(_ title: String, image: String? = nil, kind: UIButton.PillKind = .secondary, action: @escaping () -> Void) -> UIButton {
        let button = UIButton.studioPill(title: title, kind: kind, image: image, action: action)
        button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
        return button
    }

    static func menuPill(_ title: String, image: String? = "plus", menu: UIMenu) -> UIButton {
        let button = UIButton(configuration: UIButton.pillConfiguration(title: title, kind: .secondary, image: image))
        button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.menu = menu
        button.showsMenuAsPrimaryAction = true
        return button
    }
}

/// A tappable row: leading view, title and detail, a value at the right and a chevron; parted
/// from the next by a hairline the caller adds.
final class BrandRowView: UIControl {
    let titleLabel = UILabel.studio("", size: 16, lines: 0, style: .body)
    let detailLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    let valueLabel = UILabel.studio("", size: 15, color: IOSTheme.textSecondary, lines: 2, style: .subheadline)
    private let chevron = UIImageView(image: UIImage(systemName: "chevron.right", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
    private var onTap: (() -> Void)?

    init(title: String, detail: String? = nil, value: String? = nil, leading: UIView? = nil, trailing: UIView? = nil, chevron showsChevron: Bool = true, menu: UIMenu? = nil, onTap: (() -> Void)? = nil) {
        self.onTap = onTap
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        titleLabel.text = title
        detailLabel.text = detail
        detailLabel.isHidden = detail?.isEmpty ?? true
        valueLabel.text = value
        valueLabel.isHidden = value?.isEmpty ?? true
        valueLabel.textAlignment = .right
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        chevron.tintColor = IOSTheme.textTertiary
        chevron.isHidden = !showsChevron || (onTap == nil && menu == nil)
        chevron.setContentHuggingPriority(.required, for: .horizontal)
        let texts = UIStackView.v([titleLabel, detailLabel], spacing: 2)
        texts.isUserInteractionEnabled = false
        var row: [UIView] = []
        if let leading { row.append(leading) }
        row += [texts, UIView.spacer(), valueLabel]
        if let trailing { row.append(trailing) }
        row.append(chevron)
        let stack = UIStackView.h(row, spacing: 12)
        stack.isUserInteractionEnabled = trailing != nil
        if trailing == nil { valueLabel.isUserInteractionEnabled = false }
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 12, left: IOSTheme.gutter, bottom: 12, right: IOSTheme.gutter))
        heightAnchor.constraint(greaterThanOrEqualToConstant: 52).isActive = true
        if let onTap {
            addAction(UIAction { _ in onTap() }, for: .touchUpInside)
        }
        if let menu {
            rowMenu = menu
            showsMenuAsPrimaryAction = onTap == nil
            isContextMenuInteractionEnabled = true
        }
        isAccessibilityElement = trailing == nil
        accessibilityLabel = [title, detail, value].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        accessibilityTraits = (onTap != nil || menu != nil) ? .button : .staticText
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// The row's actions: its tap when it has no other, and a long press.
    private var rowMenu: UIMenu?

    override func contextMenuInteraction(_ interaction: UIContextMenuInteraction, configurationForMenuAtLocation location: CGPoint) -> UIContextMenuConfiguration? {
        guard let rowMenu else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { _ in rowMenu }
    }

    override var isHighlighted: Bool {
        didSet { backgroundColor = isHighlighted ? IOSTheme.fill : .clear }
    }
}

// MARK: - Swatch

/// A colour as a circle with its name and code under it.
final class SwatchView: UIControl {
    init(name: String, hex: String, use: String? = nil, side: CGFloat = 52, onTap: (() -> Void)? = nil) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let circle = UIView()
        circle.translatesAutoresizingMaskIntoConstraints = false
        circle.backgroundColor = UIColor(hexString: hex) ?? IOSTheme.fill
        circle.layer.cornerRadius = side / 2
        circle.layer.borderWidth = 1 / UITraitCollection.current.displayScale
        circle.layer.borderColor = IOSTheme.border.cgColor
        circle.isUserInteractionEnabled = false
        NSLayoutConstraint.activate([circle.widthAnchor.constraint(equalToConstant: side), circle.heightAnchor.constraint(equalToConstant: side)])
        let nameLabel = UILabel.studio(name, size: 12, weight: .semibold, style: .caption1)
        nameLabel.textAlignment = .center
        let hexLabel = UILabel.studio(hex, size: 11, color: IOSTheme.textSecondary, style: .caption2)
        hexLabel.font = IOSTheme.monoDigits(11)
        hexLabel.textAlignment = .center
        let stack = UIStackView.v([circle, nameLabel, hexLabel], spacing: 3, alignment: .center)
        stack.setCustomSpacing(7, after: circle)
        stack.isUserInteractionEnabled = false
        addSubview(stack)
        stack.pin(to: self)
        widthAnchor.constraint(equalToConstant: max(side, 72)).isActive = true
        if let onTap { addAction(UIAction { _ in onTap() }, for: .touchUpInside) }
        isAccessibilityElement = true
        accessibilityLabel = [name, hex, use].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
        accessibilityTraits = onTap == nil ? .image : .button
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            circle.layer.borderColor = IOSTheme.border.cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.6 : 1 }
    }
}

// MARK: - Platform mark

/// A platform's small round mark (the app has no brand glyphs: a camera for Instagram, the
/// letters for Facebook and LinkedIn), tinted by the account's state.
final class PlatformMarkView: UIView {
    init(_ platform: Platform, tint: UIColor, side: CGFloat = 34) {
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.fill
        layer.cornerRadius = side / 2
        NSLayoutConstraint.activate([widthAnchor.constraint(equalToConstant: side), heightAnchor.constraint(equalToConstant: side)])
        let glyph: UIView
        switch platform {
        case .instagram:
            let image = UIImageView(image: UIImage(systemName: "camera", withConfiguration: UIImage.SymbolConfiguration(pointSize: side * 0.42, weight: .semibold)))
            image.tintColor = tint
            glyph = image
        default:
            let label = UILabel()
            label.text = platform == .facebook ? "f" : "in"
            label.font = .systemFont(ofSize: side * (platform == .facebook ? 0.56 : 0.42), weight: .heavy)
            label.textColor = tint
            glyph = label
        }
        glyph.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glyph)
        NSLayoutConstraint.activate([glyph.centerXAnchor.constraint(equalTo: centerXAnchor), glyph.centerYAnchor.constraint(equalTo: centerYAnchor)])
        isAccessibilityElement = false
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

// MARK: - Grid

/// Tiles in equal columns, laid out by frame (the page is one scroll view, so the grid is not a
/// collection view of its own); `ratio` is a tile's height ÷ width.
final class TileGridView: UIView {
    private let columns: Int
    private let spacing: CGFloat
    private let ratio: CGFloat
    private var tiles: [UIView] = []

    init(columns: Int = 3, spacing: CGFloat = 1.5, ratio: CGFloat = 1, tiles: [UIView]) {
        self.columns = columns
        self.spacing = spacing
        self.ratio = ratio
        self.tiles = tiles
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        tiles.forEach {
            $0.translatesAutoresizingMaskIntoConstraints = true
            addSubview($0)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var tileSide: CGFloat {
        guard bounds.width > 0 else { return 0 }
        return (bounds.width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
    }

    private var lastWidth: CGFloat = 0

    override func layoutSubviews() {
        super.layoutSubviews()
        let side = tileSide
        let height = (side * ratio).rounded()
        for (index, tile) in tiles.enumerated() {
            let column = index % columns
            let row = index / columns
            tile.frame = CGRect(x: CGFloat(column) * (side + spacing), y: CGFloat(row) * (height + spacing), width: side, height: height)
        }
        if bounds.width != lastWidth {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : (window?.windowScene?.screen.bounds.width ?? 390)
        let side = (width - spacing * CGFloat(columns - 1)) / CGFloat(columns)
        let rows = (tiles.count + columns - 1) / columns
        let height = rows == 0 ? 0 : CGFloat(rows) * (side * ratio).rounded() + CGFloat(rows - 1) * spacing
        return CGSize(width: UIView.noIntrinsicMetric, height: height)
    }
}

/// Pills that wrap onto new lines (sector tags, banned words).
final class FlowView: UIView {
    private let items: [UIView]
    private let spacing: CGFloat
    private var lastWidth: CGFloat = 0

    init(_ items: [UIView], spacing: CGFloat = 8) {
        self.items = items
        self.spacing = spacing
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        items.forEach {
            $0.translatesAutoresizingMaskIntoConstraints = true
            addSubview($0)
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func layout(width: CGFloat, apply: Bool) -> CGFloat {
        var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
        for item in items {
            let size = item.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
            let w = min(size.width, width)
            if x > 0, x + w > width {
                x = 0
                y += line + spacing
                line = 0
            }
            if apply { item.frame = CGRect(x: x, y: y, width: w, height: size.height) }
            x += w + spacing
            line = max(line, size.height)
        }
        return items.isEmpty ? 0 : y + line
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        _ = layout(width: bounds.width, apply: true)
        if bounds.width != lastWidth {
            lastWidth = bounds.width
            invalidateIntrinsicContentSize()
        }
    }

    override var intrinsicContentSize: CGSize {
        let width = bounds.width > 0 ? bounds.width : (window?.windowScene?.screen.bounds.width ?? 390) - 2 * IOSTheme.gutter
        return CGSize(width: UIView.noIntrinsicMetric, height: layout(width: width, apply: false))
    }
}

/// A capsule that is on or off (sector tags) or carries a remove cross (banned words).
@MainActor
func brandChip(_ title: String, on: Bool = false, removable: Bool = false, action: @escaping () -> Void) -> UIButton {
    var config = UIButton.Configuration.filled()
    config.title = title
    config.cornerStyle = .capsule
    config.baseBackgroundColor = on ? IOSTheme.accent.withAlphaComponent(0.16) : IOSTheme.fill
    config.baseForegroundColor = on ? IOSTheme.accent : IOSTheme.textPrimary
    config.contentInsets = NSDirectionalEdgeInsets(top: 7, leading: 12, bottom: 7, trailing: 12)
    if removable {
        config.image = UIImage(systemName: "xmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .bold))
        config.imagePlacement = .trailing
        config.imagePadding = 6
    }
    config.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
        var outgoing = incoming
        outgoing.font = IOSTheme.font(14, on ? .semibold : .regular, style: .subheadline)
        return outgoing
    }
    let button = UIButton(configuration: config, primaryAction: UIAction { _ in action() })
    button.accessibilityTraits = removable ? .button : (on ? [.button, .selected] : .button)
    if removable { button.accessibilityLabel = "\(title), kaldır" }
    return button
}
