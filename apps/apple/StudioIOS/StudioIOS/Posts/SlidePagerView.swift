import AVKit
import StudioKit
import UIKit

/// Horizontal pager of a version's slides; each page zooms (pinch, double tap) and, in edit
/// mode, shows the measured layer boxes so a tap selects a layer.
final class SlidePagerView: UIView, UIScrollViewDelegate {
    var onPageChange: ((Int) -> Void)?
    var onSelectLayer: ((String?) -> Void)?
    var onPlayVideo: ((EntityID) -> Void)?

    private let scroll = UIScrollView()
    private let row = UIStackView()
    private let pageControl = UIPageControl()
    private let activity = UIView()
    private let activitySpinner = UIActivityIndicatorView(style: .medium)
    private let activityLabel = UILabel.studio("", size: 12, weight: .semibold, color: .white, style: .caption1)
    private var pages: [SlidePage] = []
    private var renderedKey: [String] = []
    private(set) var currentPage = 0

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.isPagingEnabled = true
        scroll.showsHorizontalScrollIndicator = false
        scroll.delegate = self
        scroll.clipsToBounds = false
        row.axis = .horizontal
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        addSubview(scroll)

        pageControl.translatesAutoresizingMaskIntoConstraints = false
        pageControl.currentPageIndicatorTintColor = IOSTheme.ink
        pageControl.pageIndicatorTintColor = IOSTheme.fillStrong
        pageControl.hidesForSinglePage = true
        pageControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.scrollTo(self.pageControl.currentPage, animated: true)
            self.onPageChange?(self.pageControl.currentPage)
        }, for: .valueChanged)
        addSubview(pageControl)

        activity.translatesAutoresizingMaskIntoConstraints = false
        activity.backgroundColor = UIColor.black.withAlphaComponent(0.65)
        activity.layer.cornerRadius = 14
        activitySpinner.color = .white
        activitySpinner.transform = CGAffineTransform(scaleX: 0.7, y: 0.7)
        let activityRow = UIStackView.h([activitySpinner, activityLabel], spacing: 4)
        activity.addSubview(activityRow)
        activityRow.pin(to: activity, insets: UIEdgeInsets(top: 4, left: 6, bottom: 4, right: 12))
        activity.isHidden = true
        addSubview(activity)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.heightAnchor.constraint(equalTo: scroll.widthAnchor, multiplier: 5.0 / 4.0),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            pageControl.topAnchor.constraint(equalTo: scroll.bottomAnchor, constant: 2),
            pageControl.centerXAnchor.constraint(equalTo: centerXAnchor),
            pageControl.bottomAnchor.constraint(equalTo: bottomAnchor),
            pageControl.heightAnchor.constraint(equalToConstant: 26),
            activity.leadingAnchor.constraint(equalTo: scroll.leadingAnchor, constant: 26),
            activity.topAnchor.constraint(equalTo: scroll.topAnchor, constant: 12),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Rebuild pages when the slides changed; then update overlays.
    func configure(slides: [Slide], placeholder: (title: String, eyebrow: String?, needsImage: Bool), images: IOSImageStore, editing: Bool, selectedLayer: String?, previewBoxes: [String: CGRect], selectedSlide: Int) {
        let key = slides.map { "\($0.renderedAssetId ?? "-")|\($0.html.hashValue)|\($0.width)x\($0.height)" }
        if key != renderedKey {
            renderedKey = key
            pages.forEach { $0.removeFromSuperview() }
            row.removeAllArranged()
            pages = slides.enumerated().map { index, slide in
                let page = SlidePage(slide: slide, index: index, placeholder: placeholder, images: images)
                page.onSelectLayer = { [weak self] id in self?.onSelectLayer?(id) }
                page.onPlayVideo = { [weak self] id in self?.onPlayVideo?(id) }
                return page
            }
            if pages.isEmpty {
                let empty = SlidePage(slide: nil, index: 0, placeholder: placeholder, images: images)
                pages = [empty]
            }
            for page in pages {
                row.addArrangedSubview(page)
                page.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor).isActive = true
            }
            pageControl.numberOfPages = slides.count
            layoutIfNeeded()
            scrollTo(min(selectedSlide, max(0, pages.count - 1)), animated: false)
        } else if selectedSlide != currentPage {
            scrollTo(selectedSlide, animated: true)
        }
        for (index, page) in pages.enumerated() {
            page.showOverlay(editing && index == selectedSlide, selected: selectedLayer, preview: previewBoxes)
        }
    }

    func setActivity(_ text: String?) {
        guard text != activityLabel.text || activity.isHidden != (text == nil) else { return }
        activity.isHidden = text == nil
        activityLabel.text = text
        text == nil ? activitySpinner.stopAnimating() : activitySpinner.startAnimating()
        if let text { UIAccessibility.post(notification: .announcement, argument: text) }
    }

    private func scrollTo(_ page: Int, animated: Bool) {
        currentPage = page
        pageControl.currentPage = page
        let x = CGFloat(page) * scroll.bounds.width
        if abs(scroll.contentOffset.x - x) > 1 { scroll.setContentOffset(CGPoint(x: x, y: 0), animated: animated) }
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        let x = CGFloat(currentPage) * scroll.bounds.width
        if !scroll.isDragging, !scroll.isDecelerating, abs(scroll.contentOffset.x - x) > 1 { scroll.contentOffset.x = x }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView.bounds.width > 0 else { return }
        let page = Int((scrollView.contentOffset.x / scrollView.bounds.width).rounded())
        guard page != currentPage else { return }
        currentPage = page
        pageControl.currentPage = page
        pages.forEach { $0.resetZoom() }
        onPageChange?(page)
        Haptics.selection()
    }
}

/// One slide: rendered image (or a placeholder), zoomable, with an optional layer overlay.
private final class SlidePage: UIView {
    var onSelectLayer: ((String?) -> Void)?
    var onPlayVideo: ((EntityID) -> Void)?
    private let zoom = ZoomableView()
    private let overlay = LayerOverlayView()
    private let slide: Slide?

    init(slide: Slide?, index: Int, placeholder: (title: String, eyebrow: String?, needsImage: Bool), images: IOSImageStore) {
        self.slide = slide
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        zoom.translatesAutoresizingMaskIntoConstraints = false
        addSubview(zoom)
        zoom.pin(to: self, insets: UIEdgeInsets(top: 0, left: IOSTheme.gutter, bottom: 0, right: IOSTheme.gutter))
        if let slide, slide.width > 0, slide.height > 0 { zoom.aspect = CGFloat(slide.width) / CGFloat(slide.height) }
        zoom.content.layer.cornerRadius = 18
        zoom.content.layer.cornerCurve = .continuous
        zoom.content.clipsToBounds = true

        if let rendered = slide?.renderedAssetId {
            let image = IOSAssetImageView(store: images, assetId: rendered, contentMode: .scaleAspectFit)
            zoom.content.addSubview(image)
            image.pin(to: zoom.content)
            image.isAccessibilityElement = true
            image.accessibilityLabel = "Slayt \(index + 1)"
        } else {
            zoom.content.backgroundColor = IOSTheme.postDark
            let layers = slide.map { SlideLayerScanner.layers(inHTML: $0.html, slideIndex: index) } ?? []
            let eyebrow = layers.first { $0.layerId == "eyebrow" && !$0.isHidden }?.text ?? placeholder.eyebrow
            let headline = layers.first { ($0.layerId == "title" || $0.layerId == "headline") && !$0.isHidden }?.text ?? TurkishFormat.upper(placeholder.title)
            var views: [UIView] = []
            if let eyebrow { views.append(UILabel.studio(eyebrow, size: 13, weight: .bold, color: IOSTheme.accent, style: .caption1)) }
            views.append(UILabel.studio(headline, size: 26, weight: .heavy, color: .white, lines: 4, style: .title1))
            views.append(UIView.spacer())
            if placeholder.needsImage {
                let slotBox = UIView()
                slotBox.translatesAutoresizingMaskIntoConstraints = false
                slotBox.layer.cornerRadius = 14
                slotBox.layer.borderWidth = 1.5
                slotBox.layer.borderColor = IOSTheme.accent.cgColor
                let hint = UILabel.studio("Görsel ekle\nDüzenle sekmesinden ya da aşağıdan", size: 13, weight: .medium, color: .lightGray, lines: 2, style: .footnote)
                hint.textAlignment = .center
                slotBox.addSubview(hint)
                hint.pin(to: slotBox, insets: UIEdgeInsets(top: 16, left: 12, bottom: 16, right: 12))
                views.append(slotBox)
            } else if slide == nil {
                views.append(UILabel.studio("Tasarım henüz üretilmedi", size: 13, color: .lightGray, style: .footnote))
            } else {
                views.append(UILabel.studio("Render bekleniyor", size: 13, color: .lightGray, style: .footnote))
            }
            let stack = UIStackView.v(views, spacing: 10, alignment: .fill)
            zoom.content.addSubview(stack)
            stack.pin(to: zoom.content, insets: UIEdgeInsets(top: 22, left: 20, bottom: 22, right: 20))
        }

        if let html = slide?.html, let videoId = ReelVideo.assetId(in: html) {
            let play = UIButton.studioPill(title: "Videoyu oynat", kind: .ink, image: "play.fill") { [weak self] in self?.onPlayVideo?(videoId) }
            zoom.content.addSubview(play)
            NSLayoutConstraint.activate([
                play.centerXAnchor.constraint(equalTo: zoom.content.centerXAnchor),
                play.centerYAnchor.constraint(equalTo: zoom.content.centerYAnchor),
            ])
        }

        overlay.translatesAutoresizingMaskIntoConstraints = false
        overlay.isHidden = true
        zoom.content.addSubview(overlay)
        overlay.pin(to: zoom.content)
        overlay.onTap = { [weak self] id in self?.onSelectLayer?(id) }
        if let slide { overlay.artboard = CGSize(width: slide.width, height: slide.height) }
        overlay.boxes = slide?.layers ?? []
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func showOverlay(_ show: Bool, selected: String?, preview: [String: CGRect]) {
        overlay.isHidden = !show || overlay.boxes.isEmpty
        overlay.selected = selected
        overlay.previewBoxes = show ? preview : [:]
    }

    func resetZoom() { zoom.setZoomScale(1, animated: false) }
}

/// Measured layer boxes over a slide (artboard px mapped to the view).
final class LayerOverlayView: UIView {
    var artboard = CGSize(width: 1080, height: 1350) { didSet { setNeedsLayout() } }
    var boxes: [SlideLayerBox] = [] { didSet { setNeedsLayout() } }
    var selected: String? { didSet { if selected != oldValue { setNeedsLayout() } } }
    var previewBoxes: [String: CGRect] = [:] { didSet { if previewBoxes != oldValue { setNeedsLayout() } } }
    var onTap: ((String?) -> Void)?
    private var shapes: [String: CAShapeLayer] = [:]

    override init(frame: CGRect) {
        super.init(frame: frame)
        addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped(_:))))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var geometry: SlideCanvasGeometry { SlideCanvasGeometry.fitting(artboard: artboard, in: bounds) }

    override func layoutSubviews() {
        super.layoutSubviews()
        let geometry = geometry
        let visible = boxes.filter { $0.visible && $0.w > 0 && $0.h > 0 && $0.role != "background" && $0.type != "group" }
        let ids = Set(visible.map(\.id))
        for (id, shape) in shapes where !ids.contains(id) {
            shape.removeFromSuperlayer()
            shapes[id] = nil
        }
        for box in visible {
            let shape = shapes[box.id] ?? {
                let created = CAShapeLayer()
                created.fillColor = UIColor.clear.cgColor
                layer.addSublayer(created)
                shapes[box.id] = created
                return created
            }()
            let rect = geometry.viewRect(previewBoxes[box.id] ?? box.rect).insetBy(dx: -2, dy: -2)
            shape.path = UIBezierPath(roundedRect: rect, cornerRadius: 4).cgPath
            let isSelected = box.id == selected
            shape.strokeColor = (isSelected ? IOSTheme.accent : UIColor.white.withAlphaComponent(0.7)).cgColor
            shape.lineWidth = isSelected ? 2.5 : 1
            shape.lineDashPattern = isSelected ? nil : [4, 3]
            shape.shadowColor = UIColor.black.cgColor
            shape.shadowOpacity = 0.35
            shape.shadowRadius = 1.5
            shape.shadowOffset = .zero
        }
    }

    @objc private func tapped(_ gesture: UITapGestureRecognizer) {
        let point = geometry.artboardPoint(gesture.location(in: self))
        let hit = SlideCanvasGeometry.hitTest(point, in: boxes.filter { $0.type != "group" && $0.role != "background" })
        onTap?(hit?.id)
        Haptics.selection()
    }
}

/// Reels keep their video asset id on the slide (`data-video-asset-id`, packages/contract reel.ts).
enum ReelVideo {
    static func assetId(in html: String) -> String? {
        guard let range = html.range(of: #"\sdata-video-asset-id="([^"]+)""#, options: .regularExpression) else { return nil }
        let match = html[range]
        guard let start = match.firstIndex(of: "\""), let end = match.lastIndex(of: "\""), start < end else { return nil }
        let value = String(match[match.index(after: start)..<end])
        return value.isEmpty ? nil : value
    }

    /// Download the video (auth headers) and play it full screen.
    @MainActor
    static func play(_ assetId: EntityID, app: IOSAppModel, from presenter: UIViewController) {
        Toast.show("Video indiriliyor…", in: presenter.view)
        Task {
            do {
                let data = try await app.dataService.imageData(assetId: assetId)
                let url = FileManager.default.temporaryDirectory.appendingPathComponent("studio-reel-\(assetId).mp4")
                try data.write(to: url, options: .atomic)
                let player = AVPlayerViewController()
                player.player = AVPlayer(url: url)
                presenter.present(player, animated: true) { player.player?.play() }
            } catch {
                presenter.presentError(IOSAppModel.describe(error))
            }
        }
    }
}
