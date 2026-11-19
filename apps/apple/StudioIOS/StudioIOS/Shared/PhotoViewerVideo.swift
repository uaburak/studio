import AVFoundation
import CoreImage
import StudioKit
import UIKit

/// A video asset ready for AVFoundation: streamed from the Mac with the paired device's key (M5,
/// byte ranges through `AuthenticatedMediaLoader`, nothing kept on disk), or with sample data a
/// temporary file. The asset holds its loader only weakly, so keep the stream while the asset is
/// used; the temporary file goes when the stream does.
final class VideoStream: @unchecked Sendable {
    let asset: AVURLAsset
    private let loader: AuthenticatedMediaLoader?
    private let temporaryFile: URL?

    private init(asset: AVURLAsset, loader: AuthenticatedMediaLoader?, temporaryFile: URL?) {
        self.asset = asset
        self.loader = loader
        self.temporaryFile = temporaryFile
    }

    deinit {
        if let temporaryFile { try? FileManager.default.removeItem(at: temporaryFile) }
    }

    @MainActor
    static func open(_ assetId: EntityID, app: IOSAppModel) async throws -> VideoStream {
        if app.isSample {
            let data = try await app.dataService.imageData(assetId: assetId)
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(ReelVideo.tempPrefix)\(UUID().uuidString).mp4")
            try data.write(to: url, options: .atomic)
            return VideoStream(asset: AVURLAsset(url: url), loader: nil, temporaryFile: url)
        }
        let url = try app.client.assetContentURL(assetId)
        let loader = AuthenticatedMediaLoader(source: url, headers: try await app.client.authHeaders(), session: app.client.session)
        return VideoStream(asset: loader.makeAsset(), loader: loader, temporaryFile: nil)
    }

    /// The first frame, at most `side` px on its long side, the right way up.
    func firstFrame(side: CGFloat) async -> UIImage? {
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: side, height: side)
        guard let (image, _) = try? await generator.image(at: .zero) else { return nil }
        return UIImage(cgImage: image)
    }
}

/// Videos' poster frames. The Mac makes no thumbnail of a video, so the phone takes its first
/// frame and keeps it in the image store as the asset's picture: the viewer's page, its strip
/// and the zoom flight then show it like any picture.
@MainActor
enum VideoPosters {
    private static var running: [EntityID: Task<UIImage?, Never>] = [:]
    /// Long side of a poster: the viewer's full-size width.
    static let side: CGFloat = CGFloat(IOSImageKey.fullWidth)

    /// The poster (cached, or made now; one request per video at a time).
    @discardableResult
    static func load(_ assetId: EntityID, images: IOSImageStore) async -> UIImage? {
        images.expectPhoneMade(assetId)
        if let cached = images.anyCached(assetId) { return cached }
        if let task = running[assetId] { return await task.value }
        guard let app = images.app else { return nil }
        let task = Task<UIImage?, Never> {
            guard let stream = try? await VideoStream.open(assetId, app: app) else { return nil }
            return await stream.firstFrame(side: side)
        }
        running[assetId] = task
        let image = await task.value
        running[assetId] = nil
        if let image { images.store(image, for: assetId) } else { images.phoneMadeFailed(assetId) }
        return image
    }
}

extension PhotoViewerViewController {
    /// Opens on the shown video's poster frame, the picture that flies out of the tile. A poster
    /// not made yet is waited for a moment, never long: past that the viewer opens anyway and the
    /// page shows the poster when it lands. A second tap meanwhile is ignored.
    func openOnPoster(from presenter: UIViewController) {
        guard items.indices.contains(index), items[index].isVideo, images.anyCached(items[index].assetId) == nil else {
            open(from: presenter)
            return
        }
        guard !Self.waitingForPoster else { return }
        Self.waitingForPoster = true
        let assetId = items[index].assetId
        let images = images
        var opened = false
        let openOnce = { [weak self, weak presenter] in
            guard !opened else { return }
            opened = true
            Self.waitingForPoster = false
            guard let self, let presenter, presenter.view.window != nil else { return }
            self.open(from: presenter)
        }
        Task {
            await VideoPosters.load(assetId, images: images)
            openOnce()
        }
        Task {
            try? await Task.sleep(for: .milliseconds(600))
            openOnce()
        }
    }

    @MainActor private static var waitingForPoster = false
}

/// One video playing on a viewer page: the player, its stream, and what the controls show.
@MainActor
final class VideoPlayback {
    let assetId: EntityID
    let player = AVPlayer()
    /// Called when the play state or the position changes (the controls follow).
    var onChange: (() -> Void)?
    /// Played to the end: it stops there, and play starts it again from the beginning.
    private(set) var atEnd = false

    private var stream: VideoStream?
    /// Frames for the closing flight (the picture that flies home is the frame on screen).
    private let output = AVPlayerItemVideoOutput(pixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
    private var orientation: UIImage.Orientation = .up
    private var timeObserver: Any?
    private var endObserver: (any NSObjectProtocol)?
    private var statusObservation: NSKeyValueObservation?
    private var seekTarget: CMTime?
    private var seeking = false
    private static let frames = CIContext()

    init(assetId: EntityID) {
        self.assetId = assetId
        // Paused at the end, not looping (Photos stops and shows play again).
        player.actionAtItemEnd = .pause
    }

    var isPlaying: Bool { player.timeControlStatus != .paused }

    var duration: Double {
        let seconds = player.currentItem?.duration.seconds ?? 0
        return seconds.isFinite && seconds > 0 ? seconds : 0
    }

    /// Where it is, 0…1.
    var progress: Double {
        guard duration > 0 else { return 0 }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? min(max(seconds / duration, 0), 1) : 0
    }

    func start(app: IOSAppModel) async throws {
        let stream = try await VideoStream.open(assetId, app: app)
        self.stream = stream
        if let track = try? await stream.asset.loadTracks(withMediaType: .video).first,
           let transform = try? await track.load(.preferredTransform) {
            orientation = Self.orientation(of: transform)
        }
        let item = AVPlayerItem(asset: stream.asset)
        item.add(output)
        player.replaceCurrentItem(with: item)

        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 30), queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.onChange?() }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.atEnd = true
                self?.onChange?()
            }
        }
        statusObservation = player.observe(\.timeControlStatus) { [weak self] _, _ in
            Task { @MainActor in self?.onChange?() }
        }
    }

    func play() {
        if atEnd {
            atEnd = false
            player.seek(to: .zero)
        }
        player.play()
    }

    func pause() { player.pause() }

    func togglePlay() {
        if isPlaying { pause() } else { play() }
    }

    /// Moves to `fraction` of the length, frame-exact; while a seek runs only the latest target is
    /// kept, so a dragged scrubber never queues up a backlog.
    func scrub(to fraction: Double) {
        guard duration > 0 else { return }
        atEnd = false
        seekTarget = CMTime(seconds: min(max(fraction, 0), 1) * duration, preferredTimescale: 600)
        if !seeking { seekNext() }
    }

    private func seekNext() {
        guard let target = seekTarget else {
            seeking = false
            return
        }
        seekTarget = nil
        seeking = true
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero) { [weak self] _ in
            Task { @MainActor in self?.seekNext() }
        }
    }

    /// The frame on screen now (nil before the first one is decoded).
    func currentFrame() -> UIImage? {
        guard let item = player.currentItem,
              let buffer = output.copyPixelBuffer(forItemTime: item.currentTime(), itemTimeForDisplay: nil) else { return nil }
        let image = CIImage(cvPixelBuffer: buffer)
        guard let cgImage = Self.frames.createCGImage(image, from: image.extent) else { return nil }
        return UIImage(cgImage: cgImage, scale: 1, orientation: orientation)
    }

    /// Lets the video go (the stream and any temporary file with it).
    func stop() {
        if let timeObserver { player.removeTimeObserver(timeObserver) }
        timeObserver = nil
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        endObserver = nil
        statusObservation?.invalidate()
        statusObservation = nil
        onChange = nil
        player.pause()
        player.replaceCurrentItem(with: nil)
        stream = nil
    }

    /// A phone video is stored sideways with a rotation to apply; its decoded frames need it too.
    private static func orientation(of transform: CGAffineTransform) -> UIImage.Orientation {
        let angle = atan2(transform.b, transform.a) * 180 / .pi
        switch angle.rounded() {
        case 90: return .right
        case -90: return .left
        case 180, -180: return .down
        default: return .up
        }
    }
}

/// The video of a viewer page: an `AVPlayerLayer`, aspect-fit, clear until its first frame (the
/// poster underneath shows until then).
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }

    private var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    var player: AVPlayer? {
        get { playerLayer.player }
        set { if playerLayer.player !== newValue { playerLayer.player = newValue } }
    }

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .clear
        isUserInteractionEnabled = false
        playerLayer.videoGravity = .resizeAspect
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Photos' playback capsule above the thumbnail strip: Liquid Glass with play / pause at the left,
/// the scrubber in the middle and sound on / off at the right.
final class VideoControlsView: UIView {
    var onPlay: (() -> Void)?
    var onMute: (() -> Void)?
    var onScrubBegan: (() -> Void)?
    var onScrub: ((Double) -> Void)?
    var onScrubEnded: (() -> Void)?

    private let glass = UIVisualEffectView(effect: nil)
    private let playButton = UIButton(type: .system)
    private let muteButton = UIButton(type: .system)
    private let scrubber = UISlider()
    private var shownPlaying: Bool?
    private var shownMuted: Bool?
    private(set) var isScrubbing = false

    static let height: CGFloat = 48

    override init(frame: CGRect) {
        super.init(frame: frame)
        let effect = UIGlassEffect(style: .regular)
        effect.isInteractive = true
        glass.effect = effect
        glass.cornerConfiguration = .capsule()
        glass.translatesAutoresizingMaskIntoConstraints = false
        addSubview(glass)
        glass.pin(to: self)

        for button in [playButton, muteButton] {
            button.tintColor = IOSTheme.textPrimary
            button.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                button.widthAnchor.constraint(equalToConstant: 44),
                button.heightAnchor.constraint(equalToConstant: 44),
            ])
        }
        playButton.addAction(UIAction { [weak self] _ in self?.onPlay?() }, for: .primaryActionTriggered)
        muteButton.addAction(UIAction { [weak self] _ in self?.onMute?() }, for: .primaryActionTriggered)

        scrubber.translatesAutoresizingMaskIntoConstraints = false
        scrubber.minimumTrackTintColor = IOSTheme.textPrimary
        scrubber.maximumTrackTintColor = IOSTheme.textTertiary
        scrubber.isContinuous = true
        scrubber.accessibilityLabel = "Konum"
        scrubber.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.isScrubbing = true
            self.onScrubBegan?()
        }, for: .touchDown)
        scrubber.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.onScrub?(Double(self.scrubber.value))
        }, for: .valueChanged)
        scrubber.addAction(UIAction { [weak self] _ in
            guard let self, self.isScrubbing else { return }
            self.isScrubbing = false
            self.onScrubEnded?()
        }, for: [.touchUpInside, .touchUpOutside, .touchCancel])

        let content = glass.contentView
        for view in [playButton, scrubber, muteButton] { content.addSubview(view) }
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: Self.height),
            playButton.leadingAnchor.constraint(equalTo: content.leadingAnchor, constant: 4),
            playButton.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            muteButton.trailingAnchor.constraint(equalTo: content.trailingAnchor, constant: -4),
            muteButton.centerYAnchor.constraint(equalTo: content.centerYAnchor),
            scrubber.leadingAnchor.constraint(equalTo: playButton.trailingAnchor, constant: 4),
            scrubber.trailingAnchor.constraint(equalTo: muteButton.leadingAnchor, constant: -4),
            scrubber.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])
        set(playing: false, muted: false, progress: 0)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func set(playing: Bool, muted: Bool, progress: Double) {
        let symbols = UIImage.SymbolConfiguration(pointSize: 17, weight: .semibold)
        if shownPlaying != playing {
            shownPlaying = playing
            playButton.setImage(UIImage(systemName: playing ? "pause.fill" : "play.fill", withConfiguration: symbols), for: .normal)
            playButton.accessibilityLabel = playing ? "Duraklat" : "Oynat"
        }
        if shownMuted != muted {
            shownMuted = muted
            muteButton.setImage(UIImage(systemName: muted ? "speaker.slash.fill" : "speaker.wave.2.fill", withConfiguration: symbols), for: .normal)
            muteButton.accessibilityLabel = muted ? "Sesi aç" : "Sesi kapat"
        }
        // The finger owns the scrubber while it drags.
        if !isScrubbing { scrubber.value = Float(progress) }
    }
}
