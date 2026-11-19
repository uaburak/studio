import AVFoundation
import StudioKit
import UIKit

/// Reels opened from the grid, like Instagram's Reels: one Reel per screen, paging up and down
/// between the tab's Reels, the picture (or the Reel's video, muted and looping) filling the
/// screen. Back at the top left; the post's actions in a column at the bottom right; the brand
/// and the caption at the bottom left; a thin progress line under a playing video.
final class PostReelsViewController: PostZoomPage, UICollectionViewDataSource, UICollectionViewDelegate, UIGestureRecognizerDelegate {
    private let layout = UICollectionViewFlowLayout()
    private lazy var pager = UICollectionView(frame: .zero, collectionViewLayout: layout)
    private var index: Int
    private let backButton = UIButton.glassCircle("chevron.left", label: "Geri", side: 44, pointSize: 17)
    private lazy var pullPan: UIPanGestureRecognizer = {
        let pan = UIPanGestureRecognizer(target: self, action: #selector(pulled(_:)))
        pan.delegate = self
        return pan
    }()
    private var laidOutSize: CGSize = .zero
    private var mediaHidden = false
    private var observation: IOSObservationToken?
    private var signature: Int?
    private var hasAppeared = false

    init(app: IOSAppModel, ids: [EntityID], start: EntityID, sourceFor: @escaping (EntityID) -> UIView?) {
        self.index = ids.firstIndex(of: start) ?? 0
        super.init(app: app, ids: ids, sourceFor: sourceFor)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var keepsSystemSwipeBack: Bool { false }
    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = .black
        layout.scrollDirection = .vertical
        layout.minimumLineSpacing = 0
        layout.minimumInteritemSpacing = 0
        pager.translatesAutoresizingMaskIntoConstraints = false
        pager.isPagingEnabled = true
        pager.showsVerticalScrollIndicator = false
        pager.backgroundColor = .clear
        pager.contentInsetAdjustmentBehavior = .never
        pager.dataSource = self
        pager.delegate = self
        pager.register(ReelPageCell.self, forCellWithReuseIdentifier: "reel")
        pager.topEdgeEffect.isHidden = true
        pager.bottomEdgeEffect.isHidden = true
        view.addSubview(pager)
        pager.pin(to: view)
        view.addGestureRecognizer(pullPan)
        pager.panGestureRecognizer.require(toFail: pullPan)

        backButton.addAction(UIAction { [weak self] _ in self?.close() }, for: .touchUpInside)
        view.addSubview(backButton)
        NSLayoutConstraint.activate([
            backButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            backButton.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 4),
        ])
        observation = observeIOS { [weak self] in self?.render() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        navigationController?.setNavigationBarHidden(true, animated: animated)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        hasAppeared = true
        updatePlayback()
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        hasAppeared = false
        updatePlayback()
        navigationController?.setNavigationBarHidden(false, animated: animated)
    }

    /// Board changes (approve, schedule, delete) reach the open Reels.
    private func render() {
        let current = ids.indices.contains(index) ? ids[index] : nil
        pruneIds()
        var hasher = Hasher()
        for card in cards { hasher.combine(card) }
        let next = hasher.finalize()
        guard next != signature else { return }
        let first = signature == nil
        signature = next
        guard !first else { return }
        if ids.isEmpty { return close() }
        index = current.flatMap { ids.firstIndex(of: $0) } ?? min(index, ids.count - 1)
        pager.reloadData()
        pager.layoutIfNeeded()
        pager.contentOffset.y = CGFloat(index) * pager.bounds.height
        updatePlayback()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        let size = pager.bounds.size
        guard size.width > 0, size != laidOutSize else { return }
        laidOutSize = size
        layout.itemSize = size
        layout.invalidateLayout()
        pager.layoutIfNeeded()
        pager.contentOffset = CGPoint(x: 0, y: CGFloat(index) * size.height)
        pager.layoutIfNeeded()
    }

    /// The screen's safe area (read from the window: the page's own is not known while opening).
    private var screenInsets: UIEdgeInsets {
        view.window?.safeAreaInsets ?? navigationController?.view.window?.safeAreaInsets ?? view.safeAreaInsets
    }

    private var currentCell: ReelPageCell? {
        pager.layoutIfNeeded()
        return pager.cellForItem(at: IndexPath(item: index, section: 0)) as? ReelPageCell
    }

    // MARK: The picture's flight

    override var shownImage: UIImage? {
        if let image = currentCell?.posterImage { return image }
        guard ids.indices.contains(index), let first = app.posts.card(ids[index])?.renderedAssetIds.first else { return nil }
        return app.images.anyCached(first)
    }

    override func currentSource() -> UIView? {
        tile(for: ids.indices.contains(index) ? ids[index] : nil)
    }

    override func pictureRect(in container: UIView) -> CGRect {
        view.convert(view.bounds, to: container)
    }

    override func setContentHidden(_ hidden: Bool) {
        mediaHidden = hidden
        for case let cell as ReelPageCell in pager.visibleCells { cell.setMediaHidden(hidden) }
        view.backgroundColor = hidden ? .clear : .black
        if !hidden { updatePlayback() }
    }

    override func setZoomProgress(_ progress: CGFloat) {
        pager.alpha = progress
        backButton.alpha = progress
    }

    // MARK: Pull down on the first Reel to close

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pullPan else { return true }
        let velocity = pullPan.velocity(in: view)
        return index == 0 && pager.contentOffset.y <= 1 && velocity.y > 0 && abs(velocity.y) > abs(velocity.x) * 1.5
    }

    @objc private func pulled(_ pan: UIPanGestureRecognizer) {
        if pan.state == .began { currentCell?.pause() }
        handlePull(pan)
    }

    // MARK: Pages

    func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int { ids.count }

    func collectionView(_ collectionView: UICollectionView, cellForItemAt indexPath: IndexPath) -> UICollectionViewCell {
        let cell = collectionView.dequeueReusableCell(withReuseIdentifier: "reel", for: indexPath) as! ReelPageCell
        guard ids.indices.contains(indexPath.item), let card = app.posts.card(ids[indexPath.item]) else { return cell }
        cell.configure(card: card, brand: PostPresentation.brandName(app), app: app, insets: screenInsets, actions: PostActions(app: app, host: self))
        cell.setMediaHidden(mediaHidden && indexPath.item == index)
        return cell
    }

    func collectionView(_ collectionView: UICollectionView, didEndDisplaying cell: UICollectionViewCell, forItemAt indexPath: IndexPath) {
        (cell as? ReelPageCell)?.pause()
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) { settle() }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if !decelerate { settle() }
    }

    private func settle() {
        guard pager.bounds.height > 0, !ids.isEmpty else { return }
        let page = min(max(Int((pager.contentOffset.y / pager.bounds.height).rounded()), 0), ids.count - 1)
        if page != index {
            index = page
            Haptics.selection()
        }
        updatePlayback()
    }

    /// Only the Reel on screen plays, and only while the page is open and at rest.
    private func updatePlayback() {
        let playing = hasAppeared && !mediaHidden && !isClosing
        for case let cell as ReelPageCell in pager.visibleCells {
            if playing, pager.indexPath(for: cell)?.item == index { cell.play() } else { cell.pause() }
        }
    }
}

// MARK: - One Reel

/// One Reel: the picture filling the screen (and the video over it once it plays), the action
/// column and the brand with the caption.
final class ReelPageCell: UICollectionViewCell {
    private let media = UIView()
    private let poster = IOSAssetImageView(store: nil, contentMode: .scaleAspectFill)
    private let placeholder = PostPlaceholderView()
    private let videoView = PlayerLayerView()
    private let shade = GradientView()
    private let avatar = PostAvatarView(side: 32)
    private let nameLabel = UILabel.studio("", size: 14, weight: .semibold, color: .white, style: .subheadline)
    private let captionLabel = UILabel.studio("", size: 14, color: .white, style: .subheadline)
    private let statusLabel = UILabel.studio("", size: 12, color: UIColor.white.withAlphaComponent(0.7), style: .caption1)
    private let approveButton = UIButton.glassCircle("checkmark", label: "Onayla", side: 46, pointSize: 19)
    private let editButton = UIButton.glassCircle("pencil", label: "Düzenle", side: 46, pointSize: 19)
    private let shareButton = UIButton.glassCircle("paperplane", label: "Paylaş", side: 46, pointSize: 19)
    private let scheduleButton = UIButton.glassCircle("calendar.badge.clock", label: "Zamanla", side: 46, pointSize: 19)
    private let menuButton = UIButton.glassCircle("ellipsis", label: "Diğer", side: 46, pointSize: 19)
    private let progressTrack = UIView()
    private let progressFill = UIView()
    private var progressWidth: NSLayoutConstraint!
    private var bottomInset: NSLayoutConstraint!
    private var card: PostCard?
    private var actions: PostActions?
    private var player: ReelInlinePlayer?
    private var videoAssetId: EntityID?

    var posterImage: UIImage? { poster.image }

    override init(frame: CGRect) {
        super.init(frame: frame)
        contentView.backgroundColor = .clear
        media.translatesAutoresizingMaskIntoConstraints = false
        media.backgroundColor = .black
        media.clipsToBounds = true
        contentView.addSubview(media)
        media.pin(to: contentView)
        poster.backgroundColor = .black
        media.addSubview(poster)
        poster.pin(to: media)
        placeholder.translatesAutoresizingMaskIntoConstraints = false
        media.addSubview(placeholder)
        placeholder.pin(to: media)
        videoView.translatesAutoresizingMaskIntoConstraints = false
        videoView.isUserInteractionEnabled = false
        media.addSubview(videoView)
        videoView.pin(to: media)

        shade.translatesAutoresizingMaskIntoConstraints = false
        shade.isUserInteractionEnabled = false
        contentView.addSubview(shade)

        for (button, action) in [(approveButton, { (a: PostActions, c: PostCard, _: UIView) in a.approve(c) }),
                                 (editButton, { a, c, _ in a.edit(c) }),
                                 (shareButton, { a, c, source in a.share(c, source: source) }),
                                 (scheduleButton, { a, c, _ in a.schedule(c) })] {
            button.addAction(UIAction { [weak self, weak button] _ in
                guard let self, let card = self.card, let actions = self.actions, let button else { return }
                action(actions, card, button)
            }, for: .touchUpInside)
        }
        menuButton.showsMenuAsPrimaryAction = true
        let column = UIStackView.v([approveButton, editButton, shareButton, scheduleButton, menuButton], spacing: 14, alignment: .center)
        column.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(column)

        captionLabel.lineBreakMode = .byTruncatingTail
        let brandRow = UIStackView.h([avatar, nameLabel], spacing: 10)
        let text = UIStackView.v([brandRow, captionLabel, statusLabel], spacing: 8, alignment: .leading)
        text.translatesAutoresizingMaskIntoConstraints = false
        contentView.addSubview(text)

        progressTrack.translatesAutoresizingMaskIntoConstraints = false
        progressTrack.backgroundColor = UIColor.white.withAlphaComponent(0.25)
        progressFill.translatesAutoresizingMaskIntoConstraints = false
        progressFill.backgroundColor = .white
        progressTrack.addSubview(progressFill)
        progressTrack.isHidden = true
        contentView.addSubview(progressTrack)
        progressWidth = progressFill.widthAnchor.constraint(equalTo: progressTrack.widthAnchor, multiplier: 0.0001)
        bottomInset = column.bottomAnchor.constraint(equalTo: contentView.bottomAnchor, constant: -40)

        NSLayoutConstraint.activate([
            shade.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            shade.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            shade.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
            shade.heightAnchor.constraint(equalTo: contentView.heightAnchor, multiplier: 0.4),
            column.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -14),
            bottomInset,
            text.leadingAnchor.constraint(equalTo: contentView.leadingAnchor, constant: 16),
            text.trailingAnchor.constraint(equalTo: column.leadingAnchor, constant: -18),
            text.bottomAnchor.constraint(equalTo: column.bottomAnchor),
            progressTrack.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
            progressTrack.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
            progressTrack.heightAnchor.constraint(equalToConstant: 2),
            progressTrack.topAnchor.constraint(equalTo: column.bottomAnchor, constant: 18),
            progressFill.leadingAnchor.constraint(equalTo: progressTrack.leadingAnchor),
            progressFill.topAnchor.constraint(equalTo: progressTrack.topAnchor),
            progressFill.bottomAnchor.constraint(equalTo: progressTrack.bottomAnchor),
            progressWidth,
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func prepareForReuse() {
        super.prepareForReuse()
        player?.stop()
        player = nil
        videoAssetId = nil
        videoView.playerLayer.player = nil
        progressTrack.isHidden = true
        media.alpha = 1
    }

    func configure(card: PostCard, brand: String, app: IOSAppModel, insets: UIEdgeInsets, actions: PostActions) {
        self.card = card
        self.actions = actions
        poster.store = app.images
        let asset = card.needsImage ? nil : card.renderedAssetIds.first
        poster.assetId = asset
        if poster.image == nil, let asset { poster.image = app.images.anyCached(asset) }
        poster.isHidden = asset == nil
        placeholder.isHidden = asset != nil
        if asset == nil { placeholder.configure(card) }
        avatar.set(name: brand)
        nameLabel.text = brand
        let caption = card.content.caption.replacingOccurrences(of: "\n", with: " ")
        captionLabel.text = caption.isEmpty ? card.title : caption
        statusLabel.text = PostPresentation.statusLine(card)
        bottomInset.constant = -(insets.bottom + 28)

        let approved = card.content.status.hasApproval
        var approve = approveButton.configuration
        approve?.image = UIImage(systemName: approved ? "checkmark.circle.fill" : "checkmark", withConfiguration: UIImage.SymbolConfiguration(pointSize: 19, weight: .regular))
        approve?.baseForegroundColor = approved ? IOSTheme.accent : .white
        approveButton.configuration = approve
        approveButton.isUserInteractionEnabled = PostActions.canApprove(card)
        approveButton.accessibilityLabel = approved ? "Onaylandı" : "Onayla"
        for button in [editButton, shareButton, scheduleButton, menuButton] { button.configuration?.baseForegroundColor = .white }
        shareButton.isEnabled = !card.renderedAssetIds.isEmpty
        scheduleButton.isEnabled = PostActions.canSchedule(card)
        menuButton.menu = actions.menu(for: card, source: menuButton)

        // The Reel's video, when it has one (played muted and looping while on screen).
        let video = card.version?.slides.first.flatMap { ReelVideo.assetId(in: $0.html) }
        if video != videoAssetId {
            player?.stop()
            player = nil
            videoAssetId = video
            progressTrack.isHidden = true
            if let video {
                let player = ReelInlinePlayer(assetId: video, app: app)
                player.onProgress = { [weak self] fraction in self?.setProgress(fraction) }
                videoView.playerLayer.player = nil
                player.onReady = { [weak self, weak player] in
                    guard let self, let player else { return }
                    self.videoView.playerLayer.player = player.player
                    self.progressTrack.isHidden = false
                }
                self.player = player
            }
        }
    }

    func setMediaHidden(_ hidden: Bool) {
        media.alpha = hidden ? 0 : 1
    }

    func play() { player?.play() }
    func pause() { player?.pause() }

    private func setProgress(_ fraction: Double) {
        progressWidth.isActive = false
        progressWidth = progressFill.widthAnchor.constraint(equalTo: progressTrack.widthAnchor, multiplier: max(CGFloat(fraction), 0.0001))
        progressWidth.isActive = true
    }
}

/// A view whose layer is an AVPlayerLayer (fills, keeps the video's shape by cropping).
final class PlayerLayerView: UIView {
    override class var layerClass: AnyClass { AVPlayerLayer.self }
    var playerLayer: AVPlayerLayer { layer as! AVPlayerLayer }

    override init(frame: CGRect) {
        super.init(frame: frame)
        playerLayer.videoGravity = .resizeAspectFill
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

/// Clear at the top, darker at the bottom (text over a picture stays readable).
final class GradientView: UIView {
    override class var layerClass: AnyClass { CAGradientLayer.self }

    override init(frame: CGRect) {
        super.init(frame: frame)
        let gradient = layer as! CAGradientLayer
        gradient.colors = [UIColor.black.withAlphaComponent(0).cgColor, UIColor.black.withAlphaComponent(0.55).cgColor]
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Darker at the top instead (the story's header).
    func flip() {
        let gradient = layer as! CAGradientLayer
        gradient.colors = [UIColor.black.withAlphaComponent(0.45).cgColor, UIColor.black.withAlphaComponent(0).cgColor]
    }
}

/// A Reel's video played in place, muted and looping: streamed from the Mac with the paired
/// device's key like the full-screen player (`ReelVideo.play`); sample data uses a temporary file
/// deleted when it stops.
@MainActor
final class ReelInlinePlayer {
    private(set) var player: AVQueuePlayer?
    var onReady: (() -> Void)?
    var onProgress: ((Double) -> Void)?
    private var looper: AVPlayerLooper?
    private var loader: AuthenticatedMediaLoader?
    private var temporaryFile: URL?
    private var timeObserver: Any?
    private var task: Task<Void, Never>?
    private var wantsPlay = false

    init(assetId: EntityID, app: IOSAppModel) {
        task = Task { [weak self] in
            do {
                let item: AVPlayerItem
                var loader: AuthenticatedMediaLoader?
                var file: URL?
                if app.isSample {
                    let data = try await app.dataService.imageData(assetId: assetId)
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("\(ReelVideo.tempPrefix)\(UUID().uuidString).mp4")
                    try data.write(to: url, options: .atomic)
                    file = url
                    item = AVPlayerItem(url: url)
                } else {
                    let url = try app.client.assetContentURL(assetId)
                    let made = AuthenticatedMediaLoader(source: url, headers: try await app.client.authHeaders(), session: app.client.session)
                    loader = made
                    item = AVPlayerItem(asset: made.makeAsset())
                }
                guard let self, !Task.isCancelled else {
                    if let file { try? FileManager.default.removeItem(at: file) }
                    return
                }
                self.start(item, loader: loader, file: file)
            } catch {
                // No video: the poster stays.
            }
        }
    }

    private func start(_ item: AVPlayerItem, loader: AuthenticatedMediaLoader?, file: URL?) {
        self.loader = loader
        temporaryFile = file
        let player = AVQueuePlayer()
        player.isMuted = true
        player.preventsDisplaySleepDuringVideoPlayback = false
        looper = AVPlayerLooper(player: player, templateItem: item)
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 20), queue: .main) { [weak self, weak player] time in
            MainActor.assumeIsolated {
                guard let self, let duration = player?.currentItem?.duration, duration.isNumeric, duration.seconds > 0 else { return }
                self.onProgress?(min(max(time.seconds / duration.seconds, 0), 1))
            }
        }
        self.player = player
        onReady?()
        if wantsPlay { player.play() }
    }

    func play() {
        wantsPlay = true
        player?.play()
    }

    func pause() {
        wantsPlay = false
        player?.pause()
    }

    func stop() {
        task?.cancel()
        task = nil
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        timeObserver = nil
        player?.pause()
        looper?.disableLooping()
        looper = nil
        player?.removeAllItems()
        player = nil
        loader = nil
        if let temporaryFile { try? FileManager.default.removeItem(at: temporaryFile) }
        temporaryFile = nil
    }
}
