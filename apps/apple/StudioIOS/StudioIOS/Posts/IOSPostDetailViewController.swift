import AVFoundation
import AVKit
import Foundation
import Observation
import PhotosUI
import StudioKit
import UIKit

/// Pure UIKit post detail model for `StudioIOS` (`PLAN.md` §9):
/// - Multi-slide horizontal preview + Reels `AVPlayerViewController`
/// - Quick `SlideLayers` text layer editor form (`patchLayersAndRender`)
/// - Fill image slot from iPhone Photos / Camera (`fillSlotAndRender`)
/// - Caption & `#etiketler` editing
/// - Cryptographic hash **Onayla** + **Zamanla** (`UIDatePicker` + accounts).
@MainActor
@Observable
final class IOSPostDetailModel {
    unowned let app: IOSAppModel
    private(set) var card: PostCard
    var selectedSlideIndex = 0

    var captionDraft: String
    var hashtagsDraft: String
    var originalLayers: [SlideLayer] = []
    var editableLayers: [SlideLayer] = []

    var scheduleDate: Date
    var selectedAccountIds: Set<EntityID> = []

    private(set) var isBusy = false
    var statusMessage: String?
    var error: String?
    private(set) var reelVideoURL: URL?

    init(app: IOSAppModel, card: PostCard) {
        self.app = app
        self.card = card
        let parts = CaptionParts(caption: card.content.caption)
        self.captionDraft = parts.body
        self.hashtagsDraft = parts.hashtags.joined(separator: " ")
        self.scheduleDate = card.schedule?.scheduledAt ?? Date().addingTimeInterval(3600)
        self.selectedAccountIds = Set(
            app.accounts(of: card.content.brandId)
                .filter { $0.status != .disabled && card.content.targetPlatforms.contains($0.platform) }
                .map(\.id)
        )
        syncLayers()
        if card.content.type == .reel {
            Task { [weak self] in await self?.resolveReelVideo() }
        }
    }

    var content: Content { card.content }
    var slides: [Slide] { card.version?.slides ?? [] }
    var canApprove: Bool { card.approvableHash != nil && !isBusy }
    var hasLayerChanges: Bool { !SlideLayerScanner.diff(from: originalLayers, to: editableLayers).isEmpty }

    var schedulableAccounts: [SocialAccount] {
        app.accounts(of: content.brandId).filter { $0.status != .disabled && content.targetPlatforms.contains($0.platform) }
    }

    func selectSlide(_ index: Int) {
        let clamped = max(0, min(index, max(0, slides.count - 1)))
        guard clamped != selectedSlideIndex else { return }
        selectedSlideIndex = clamped
        syncLayers()
    }

    func syncLayers() {
        guard slides.indices.contains(selectedSlideIndex) else {
            originalLayers = []
            editableLayers = []
            return
        }
        let scanned = SlideLayerScanner.layers(inHTML: slides[selectedSlideIndex].html, slideIndex: selectedSlideIndex)
        originalLayers = scanned
        editableLayers = scanned
    }

    private func resolveReelVideo() async {
        guard let videos = try? await app.dataService.assets(brandId: content.brandId, kind: .video),
              let first = videos.first else { return }
        if !app.isSample, let url = try? app.settings.makeClient().assetContentURL(first.id) {
            reelVideoURL = url
        } else if let data = try? await app.dataService.imageData(assetId: first.id) {
            let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("ios-reel-\(first.id).mp4")
            try? data.write(to: tmp)
            reelVideoURL = tmp
        }
    }

    func reloadFromBoard() async {
        await app.posts.load()
        if let fresh = app.posts.card(content.id) {
            card = fresh
            syncLayers()
        }
    }

    func fillSlot(with image: UIImage) async {
        guard !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let imported = try IOSImageImport.from(image: image, filename: "yuva.jpg")
            let asset = try await app.dataService.uploadImage(imported.file, brandId: content.brandId) { _ in }
            app.images.seed(imported.thumbnail, for: asset.id)
            let slotId = card.slots.first(where: \.isEmpty)?.layerId ?? card.slots.first?.layerId ?? "photo"
            _ = try await app.dataService.fillSlotAndRender(contentId: content.id, slotId: slotId, assetId: asset.id)
            await reloadFromBoard()
            statusMessage = "Görsel yuvaya yerleştirildi."
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func applyLayerEdits() async {
        let patches = SlideLayerScanner.diff(from: originalLayers, to: editableLayers)
        guard !patches.isEmpty, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            let job = try await app.dataService.patchLayersAndRender(contentId: content.id, patches: patches)
            await reloadFromBoard()
            statusMessage = job.status == .succeeded
                ? "Katmanlar güncellendi ve yeni sürüm hazırlandı."
                : "Katman değişikliği Mac'te render kuyruğuna alındı."
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func saveCaption() async {
        let combined = CaptionParts(
            body: captionDraft.trimmingCharacters(in: .whitespacesAndNewlines),
            hashtags: CaptionParts.parseHashtags(hashtagsDraft)
        ).caption
        guard combined != content.caption, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await app.dataService.updateCaption(contentId: content.id, caption: combined)
            await reloadFromBoard()
            statusMessage = "Açıklama kaydedildi."
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func approve() async {
        guard let hash = card.approvableHash, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            _ = try await app.dataService.approve(contentId: content.id, hash: hash)
            await reloadFromBoard()
            statusMessage = "Post kriptografik özetle onaylandı."
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func schedulePost() async {
        guard !selectedAccountIds.isEmpty, !isBusy else { return }
        isBusy = true
        defer { isBusy = false }
        do {
            if !content.status.isSchedulable {
                guard let hash = card.approvableHash else {
                    error = "Zamanlamak için önce sürüm onaylanmalı."
                    return
                }
                _ = try await app.dataService.approve(contentId: content.id, hash: hash)
            }
            for accountId in selectedAccountIds {
                _ = try await app.dataService.createSchedule(
                    ScheduleCreate(contentId: content.id, socialAccountId: accountId, scheduledAt: scheduleDate)
                )
            }
            await reloadFromBoard()
            await app.calendar.load()
            statusMessage = "Yayın zamanlandı."
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }
}

// MARK: - IOSPostDetailViewController (100% Pure UIKit)

final class IOSPostDetailViewController: UIViewController,
    UIScrollViewDelegate,
    PHPickerViewControllerDelegate,
    UIImagePickerControllerDelegate,
    UINavigationControllerDelegate
{
    let model: IOSPostDetailModel

    private let mainScroll = UIScrollView()
    private let mainStack = UIStackView()

    // Slide paging / Reels video
    private let slideScroll = UIScrollView()
    private let slidesRow = UIStackView()
    private let pageControl = UIPageControl()
    private var playerController: AVPlayerViewController?

    // Slot fill bar
    private let slotCard = IOSCardView(padding: 14, spacing: 8)

    // Quick text layer editor card
    private let layersCard = IOSCardView(padding: 14, spacing: 10)
    private let layersFormStack = UIStackView()
    private var applyLayersButton: UIButton!
    private var renderedLayersKey: [SlideLayer] = []

    // Caption card
    private let captionTextView = UITextView()
    private let hashtagsField = UITextField()

    // Schedule & Approve card
    private let datePicker = UIDatePicker()
    private let accountsStack = UIStackView()
    private var approveButton: UIButton!
    private var scheduleButton: UIButton!

    private let feedbackLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0)
    private var observation: IOSObservationToken?

    init(model: IOSPostDetailModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
        title = model.content.title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground

        mainScroll.translatesAutoresizingMaskIntoConstraints = false
        mainScroll.keyboardDismissMode = .interactive
        mainStack.axis = .vertical
        mainStack.spacing = 16
        mainStack.translatesAutoresizingMaskIntoConstraints = false
        mainScroll.addSubview(mainStack)
        view.addSubview(mainScroll)

        NSLayoutConstraint.activate([
            mainScroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            mainScroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            mainScroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            mainScroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            mainStack.leadingAnchor.constraint(equalTo: mainScroll.contentLayoutGuide.leadingAnchor, constant: 16),
            mainStack.trailingAnchor.constraint(equalTo: mainScroll.contentLayoutGuide.trailingAnchor, constant: -16),
            mainStack.topAnchor.constraint(equalTo: mainScroll.contentLayoutGuide.topAnchor, constant: 14),
            mainStack.bottomAnchor.constraint(equalTo: mainScroll.contentLayoutGuide.bottomAnchor, constant: -32),
            mainStack.widthAnchor.constraint(equalTo: mainScroll.frameLayoutGuide.widthAnchor, constant: -32),
        ])

        buildPreviewSection()
        buildSlotSection()
        buildQuickLayerEditorSection()
        buildCaptionSection()
        buildApproveAndScheduleSection()

        feedbackLabel.isHidden = true
        mainStack.addArrangedSubview(feedbackLabel)

        observation = observeIOS { [weak self] in
            self?.render()
        }
    }

    private func buildPreviewSection() {
        if model.content.type == .reel {
            let pvc = AVPlayerViewController()
            addChild(pvc)
            pvc.view.translatesAutoresizingMaskIntoConstraints = false
            pvc.view.layer.cornerRadius = 18
            pvc.view.clipsToBounds = true
            pvc.view.heightAnchor.constraint(equalTo: pvc.view.widthAnchor, multiplier: 16.0 / 9.0).isActive = true
            mainStack.addArrangedSubview(pvc.view)
            pvc.didMove(toParent: self)
            self.playerController = pvc
        }

        slideScroll.isPagingEnabled = true
        slideScroll.showsHorizontalScrollIndicator = false
        slideScroll.delegate = self
        slideScroll.layer.cornerRadius = 18
        slideScroll.clipsToBounds = true
        slideScroll.translatesAutoresizingMaskIntoConstraints = false
        slideScroll.heightAnchor.constraint(equalTo: slideScroll.widthAnchor, multiplier: 5.0 / 4.0).isActive = true

        slidesRow.axis = .horizontal
        slidesRow.spacing = 0
        slidesRow.translatesAutoresizingMaskIntoConstraints = false
        slideScroll.addSubview(slidesRow)
        NSLayoutConstraint.activate([
            slidesRow.leadingAnchor.constraint(equalTo: slideScroll.contentLayoutGuide.leadingAnchor),
            slidesRow.trailingAnchor.constraint(equalTo: slideScroll.contentLayoutGuide.trailingAnchor),
            slidesRow.topAnchor.constraint(equalTo: slideScroll.contentLayoutGuide.topAnchor),
            slidesRow.bottomAnchor.constraint(equalTo: slideScroll.contentLayoutGuide.bottomAnchor),
            slidesRow.heightAnchor.constraint(equalTo: slideScroll.frameLayoutGuide.heightAnchor),
        ])

        pageControl.currentPageIndicatorTintColor = IOSTheme.accent
        pageControl.pageIndicatorTintColor = IOSTheme.border
        pageControl.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            let page = self.pageControl.currentPage
            self.model.selectSlide(page)
            let offset = CGPoint(x: CGFloat(page) * self.slideScroll.bounds.width, y: 0)
            self.slideScroll.setContentOffset(offset, animated: true)
        }, for: .valueChanged)

        mainStack.addArrangedSubview(slideScroll)
        mainStack.addArrangedSubview(pageControl)
    }

    private func buildSlotSection() {
        slotCard.stack.addArrangedSubview(UILabel.studio("Görsel Yuvasını Doldur", size: 15, weight: .bold))
        slotCard.stack.addArrangedSubview(UILabel.studio("iPhone arşivinden veya kameradan ürün fotoğrafı yükle; Mac yuvaya yerleştirip yeniden render eder.", size: 12, color: IOSTheme.textSecondary, lines: 0))

        let photosBtn = UIButton.studioPill(title: "Fotoğraflardan Seç", primary: true) { [weak self] in
            self?.pickFromPhotos()
        }
        let cameraBtn = UIButton.studioPill(title: "Kamera") { [weak self] in
            self?.pickFromCamera()
        }
        let row = UIStackView(arrangedSubviews: [photosBtn, cameraBtn, UIView()])
        row.axis = .horizontal
        row.spacing = 8
        slotCard.stack.addArrangedSubview(row)
        mainStack.addArrangedSubview(slotCard)
    }

    private func buildQuickLayerEditorSection() {
        layersCard.stack.addArrangedSubview(UILabel.studio("Hızlı Metin ve Katman Düzeltme", size: 15, weight: .bold))
        layersCard.stack.addArrangedSubview(UILabel.studio("Değişiklikler Mac'te tasarım kurallarıyla yeniden render edilir.", size: 12, color: IOSTheme.textSecondary, lines: 0))

        layersFormStack.axis = .vertical
        layersFormStack.spacing = 10
        layersCard.stack.addArrangedSubview(layersFormStack)

        applyLayersButton = UIButton.studioPill(title: "Katmanları Kaydet ve Render Et", primary: true) { [weak self] in
            guard let self else { return }
            Task { await self.model.applyLayerEdits() }
        }
        layersCard.stack.addArrangedSubview(applyLayersButton)
        mainStack.addArrangedSubview(layersCard)
    }

    private func buildCaptionSection() {
        let card = IOSCardView(padding: 14, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("Açıklama ve Etiketler", size: 15, weight: .bold))

        captionTextView.font = UIFont.systemFont(ofSize: 14)
        captionTextView.textColor = IOSTheme.textPrimary
        captionTextView.backgroundColor = IOSTheme.fill
        captionTextView.layer.cornerRadius = 12
        captionTextView.textContainerInset = UIEdgeInsets(top: 10, left: 8, bottom: 10, right: 8)
        captionTextView.translatesAutoresizingMaskIntoConstraints = false
        captionTextView.heightAnchor.constraint(equalToConstant: 100).isActive = true

        hashtagsField.placeholder = "#etiketler"
        hashtagsField.font = UIFont.systemFont(ofSize: 13)
        hashtagsField.textColor = IOSTheme.textSecondary
        hashtagsField.backgroundColor = IOSTheme.fill
        hashtagsField.layer.cornerRadius = 12
        hashtagsField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
        hashtagsField.leftViewMode = .always
        hashtagsField.translatesAutoresizingMaskIntoConstraints = false
        hashtagsField.heightAnchor.constraint(equalToConstant: 36).isActive = true

        let saveCapBtn = UIButton.studioPill(title: "Açıklamayı Kaydet") { [weak self] in
            guard let self else { return }
            self.model.captionDraft = self.captionTextView.text ?? ""
            self.model.hashtagsDraft = self.hashtagsField.text ?? ""
            Task { await self.model.saveCaption() }
        }

        card.stack.addArrangedSubview(captionTextView)
        card.stack.addArrangedSubview(hashtagsField)
        card.stack.addArrangedSubview(saveCapBtn)
        mainStack.addArrangedSubview(card)
    }

    private func buildApproveAndScheduleSection() {
        let card = IOSCardView(padding: 14, spacing: 12)
        card.stack.addArrangedSubview(UILabel.studio("Onay ve Zamanlama", size: 15, weight: .bold))

        approveButton = UIButton.studioPill(title: "Sürümü Onayla", primary: true) { [weak self] in
            guard let self else { return }
            Task { await self.model.approve() }
        }
        card.stack.addArrangedSubview(approveButton)

        datePicker.datePickerMode = .dateAndTime
        datePicker.preferredDatePickerStyle = .compact
        datePicker.locale = TurkishFormat.locale
        datePicker.minimumDate = Date()
        datePicker.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.model.scheduleDate = self.datePicker.date
        }, for: .valueChanged)

        let dateRow = UIStackView(arrangedSubviews: [UILabel.studio("Yayın Zamanı", size: 14, weight: .medium), UIView(), datePicker])
        dateRow.axis = .horizontal
        dateRow.alignment = .center
        card.stack.addArrangedSubview(dateRow)

        accountsStack.axis = .vertical
        accountsStack.spacing = 8
        card.stack.addArrangedSubview(accountsStack)

        scheduleButton = UIButton.studioPill(title: "Zamanla", primary: false) { [weak self] in
            guard let self else { return }
            Task { await self.model.schedulePost() }
        }
        card.stack.addArrangedSubview(scheduleButton)
        mainStack.addArrangedSubview(card)
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        guard scrollView === slideScroll, slideScroll.bounds.width > 0 else { return }
        let idx = Int(round(slideScroll.contentOffset.x / slideScroll.bounds.width))
        model.selectSlide(idx)
    }

    private func render() {
        if let url = model.reelVideoURL, playerController?.player == nil {
            playerController?.player = AVPlayer(url: url)
        }

        // Slides
        slidesRow.arrangedSubviews.forEach {
            slidesRow.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        let slides = model.slides
        for (i, slide) in slides.enumerated() {
            let page = makeSlidePageView(slide: slide, index: i)
            slidesRow.addArrangedSubview(page)
            page.widthAnchor.constraint(equalTo: slideScroll.frameLayoutGuide.widthAnchor).isActive = true
        }
        pageControl.numberOfPages = slides.count
        pageControl.currentPage = model.selectedSlideIndex
        pageControl.isHidden = slides.count <= 1

        slotCard.isHidden = model.card.slots.isEmpty && !model.card.needsImage

        // Quick layer form
        if model.originalLayers != renderedLayersKey {
            renderedLayersKey = model.originalLayers
            rebuildLayerForm()
        }
        applyLayersButton.isEnabled = model.hasLayerChanges && !model.isBusy

        if !captionTextView.isFirstResponder && captionTextView.text != model.captionDraft {
            captionTextView.text = model.captionDraft
        }
        if !hashtagsField.isFirstResponder && hashtagsField.text != model.hashtagsDraft {
            hashtagsField.text = model.hashtagsDraft
        }

        approveButton.configuration?.title = model.content.status.hasApproval ? "✓ Onaylandı" : "Bu Sürümü Onayla"
        approveButton.isEnabled = model.canApprove

        datePicker.date = model.scheduleDate
        rebuildAccountsToggles()
        scheduleButton.isEnabled = !model.selectedAccountIds.isEmpty && !model.isBusy

        if let err = model.error {
            feedbackLabel.text = err
            feedbackLabel.textColor = .systemRed
            feedbackLabel.isHidden = false
        } else if let msg = model.statusMessage {
            feedbackLabel.text = msg
            feedbackLabel.textColor = IOSTheme.textSecondary
            feedbackLabel.isHidden = false
        } else {
            feedbackLabel.isHidden = true
        }
    }

    private func makeSlidePageView(slide: Slide, index: Int) -> UIView {
        if let renderedId = slide.renderedAssetId, !model.card.needsImage {
            return IOSAssetImageView(store: model.app.images, assetId: renderedId, cornerRadius: 0)
        }
        let page = UIView()
        page.translatesAutoresizingMaskIntoConstraints = false
        page.backgroundColor = IOSTheme.postDark
        let layers = SlideLayerScanner.layers(inHTML: slide.html, slideIndex: index)
        let eyebrow = layers.first { $0.layerId == "eyebrow" && !$0.isHidden }?.text ?? model.card.eyebrow
        let headline = layers.first { ($0.layerId == "title" || $0.layerId == "headline") && !$0.isHidden }?.text ?? TurkishFormat.upper(model.content.title)

        let stack = UIStackView()
        stack.axis = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        if let eyebrow {
            stack.addArrangedSubview(UILabel.studio(eyebrow, size: 12, weight: .bold, color: IOSTheme.accent))
        }
        stack.addArrangedSubview(UILabel.studio(headline, size: 22, weight: .heavy, color: .white, lines: 4))
        stack.addArrangedSubview(UIView())
        if model.card.needsImage {
            stack.addArrangedSubview(UILabel.studio("Görsel yuvası boş · aşağıdan fotoğraf seç", size: 12, color: .lightGray))
        }
        page.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: page.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: page.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: page.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: page.bottomAnchor, constant: -22),
        ])
        return page
    }

    private func rebuildLayerForm() {
        layersFormStack.arrangedSubviews.forEach {
            layersFormStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        if model.editableLayers.isEmpty {
            layersFormStack.addArrangedSubview(UILabel.studio("Düzenlenebilir katman yok.", size: 13, color: IOSTheme.textTertiary))
            return
        }
        for idx in model.editableLayers.indices {
            let layer = model.editableLayers[idx]
            let box = UIStackView()
            box.axis = .vertical
            box.spacing = 6

            let sw = UISwitch()
            sw.isOn = !layer.isHidden
            sw.onTintColor = IOSTheme.accent
            sw.addAction(UIAction { [weak self, weak sw] _ in
                guard let self, let sw, self.model.editableLayers.indices.contains(idx) else { return }
                self.model.editableLayers[idx].isHidden = !sw.isOn
                self.applyLayersButton.isEnabled = self.model.hasLayerChanges
            }, for: .valueChanged)

            let head = UIStackView(arrangedSubviews: [
                UILabel.studio("\(layer.layerId) · \(layer.kind.label)", size: 12, weight: .semibold, color: IOSTheme.textSecondary),
                UIView(),
                sw,
            ])
            head.axis = .horizontal
            head.alignment = .center
            box.addArrangedSubview(head)

            if layer.kind == .text {
                let tf = UITextField()
                tf.text = layer.text
                tf.font = UIFont.systemFont(ofSize: 14)
                tf.textColor = IOSTheme.textPrimary
                tf.backgroundColor = IOSTheme.fill
                tf.layer.cornerRadius = 10
                tf.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 10, height: 1))
                tf.leftViewMode = .always
                tf.translatesAutoresizingMaskIntoConstraints = false
                tf.heightAnchor.constraint(equalToConstant: 36).isActive = true
                tf.addAction(UIAction { [weak self, weak tf] _ in
                    guard let self, let tf, self.model.editableLayers.indices.contains(idx) else { return }
                    self.model.editableLayers[idx].text = tf.text ?? ""
                    self.applyLayersButton.isEnabled = self.model.hasLayerChanges
                }, for: .editingChanged)
                box.addArrangedSubview(tf)
            }
            layersFormStack.addArrangedSubview(box)
        }
    }

    private func rebuildAccountsToggles() {
        accountsStack.arrangedSubviews.forEach {
            accountsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        for acc in model.schedulableAccounts {
            let sw = UISwitch()
            sw.isOn = model.selectedAccountIds.contains(acc.id)
            sw.onTintColor = IOSTheme.accent
            sw.addAction(UIAction { [weak self, weak sw] _ in
                guard let self, let sw else { return }
                if sw.isOn {
                    self.model.selectedAccountIds.insert(acc.id)
                } else {
                    self.model.selectedAccountIds.remove(acc.id)
                }
            }, for: .valueChanged)
            let row = UIStackView(arrangedSubviews: [
                UILabel.studio("\(acc.platform.displayName) · \(acc.handle)", size: 13),
                UIView(),
                sw,
            ])
            row.axis = .horizontal
            row.alignment = .center
            accountsStack.addArrangedSubview(row)
        }
    }

    // MARK: - Photos & Camera Slot Pickers

    private func pickFromPhotos() {
        var cfg = PHPickerConfiguration()
        cfg.filter = .images
        cfg.selectionLimit = 1
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        present(picker, animated: true)
    }

    private func pickFromCamera() {
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            pickFromPhotos()
            return
        }
        let cam = UIImagePickerController()
        cam.sourceType = .camera
        cam.delegate = self
        present(cam, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let first = results.first, first.itemProvider.canLoadObject(ofClass: UIImage.self) else { return }
        first.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] obj, _ in
            guard let img = obj as? UIImage else { return }
            Task { @MainActor [weak self] in
                await self?.model.fillSlot(with: img)
            }
        }
    }

    func imagePickerController(_ picker: UIImagePickerController, didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
        picker.dismiss(animated: true)
        if let img = info[.originalImage] as? UIImage {
            Task { await model.fillSlot(with: img) }
        }
    }
}
