import Observation
import StudioKit
import UIKit

/// Ürünler (N23): the brand's products, each with its photos (the first is the cover), name,
/// category, description, tags and notes. "Fotoğrafla hızlı ekle": a photo from the camera or
/// Photos is uploaded, the product form opens with it, and what the Mac read on the photo
/// (the label's text, its tags, the AI description when on) fills the empty fields.
@MainActor
@Observable
final class IOSProductsModel {
    weak var app: IOSAppModel?
    private(set) var products: [BrandProduct] = []
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    var error: String?

    init(app: IOSAppModel) {
        self.app = app
    }

    var brandId: EntityID? { app?.currentBrandId }

    func load() async {
        guard let app, let brandId else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let loaded = try await app.dataService.products(brandId: brandId)
            guard brandId == self.brandId else { return }
            products = loaded
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
        hasLoaded = true
    }

    func saved(_ product: BrandProduct) {
        guard product.brandId == brandId else { return }
        if let index = products.firstIndex(where: { $0.id == product.id }) {
            products[index] = product
        } else {
            products.append(product)
        }
    }

    func delete(_ product: BrandProduct) async -> String? {
        guard let app else { return nil }
        do {
            try await app.dataService.deleteProduct(brandId: product.brandId, id: product.id)
            products.removeAll { $0.id == product.id }
            return nil
        } catch {
            return IOSAppModel.describe(error)
        }
    }
}

final class IOSProductsViewController: UITableViewController {
    private unowned let app: IOSAppModel
    private let model: IOSProductsModel
    private var observation: IOSObservationToken?
    private var lastBrandId: EntityID?
    private let emptyView = EmptyStateView()

    init(app: IOSAppModel) {
        self.app = app
        self.model = IOSProductsModel(app: app)
        super.init(style: .insetGrouped)
        title = "Ürünler"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .never
        tableView.backgroundColor = IOSTheme.groupedBackground
        let add = UIBarButtonItem(systemItem: .add)
        add.menu = addMenu()
        add.accessibilityLabel = "Ürün ekle"
        navigationItem.rightBarButtonItem = add
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task { await self?.model.load(); refresh?.endRefreshing() }
        }, for: .valueChanged)
        refreshControl = refresh
        observation = observeIOS { [weak self] in self?.render() }
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            lastBrandId = app.currentBrandId
            Task { await model.load() }
        }
        _ = model.products
        _ = model.error
        if model.products.isEmpty, model.hasLoaded {
            emptyView.configure(
                icon: "shippingbox", title: app.currentBrandId == nil ? "Marka seçilmedi" : "Henüz ürün yok",
                message: app.currentBrandId == nil
                    ? "Ürünler markaya göre tutulur; önce bir marka seç."
                    : "Ürünün fotoğrafını çek; Mac etiketteki yazıyı okuyup adını önerir. Postlar ürünleri doğru adıyla gösterir.",
                actions: app.currentBrandId == nil ? [] : [UIButton.studioPill(title: "Fotoğrafla ekle", kind: .primary, image: "camera") { [weak self] in self?.quickAdd(camera: ImagePicking.cameraAvailable) }])
            tableView.backgroundView = emptyView
        } else {
            tableView.backgroundView = nil
        }
        tableView.reloadData()
    }

    private func addMenu() -> UIMenu {
        var quick: [UIMenuElement] = []
        if ImagePicking.cameraAvailable {
            quick.append(UIAction(title: "Fotoğraf çek", image: UIImage(systemName: "camera")) { [weak self] _ in self?.quickAdd(camera: true) })
        }
        quick.append(UIAction(title: "Fotoğraflar'dan seç", image: UIImage(systemName: "photo")) { [weak self] _ in self?.quickAdd(camera: false) })
        return UIMenu(children: [
            UIMenu(title: "Fotoğrafla hızlı ekle", options: .displayInline, children: quick),
            UIAction(title: "Fotoğrafsız ekle", image: UIImage(systemName: "square.and.pencil")) { [weak self] _ in self?.openEditor(nil) },
        ])
    }

    private func quickAdd(camera: Bool) {
        guard app.currentBrandId != nil else {
            presentError("Önce bir marka seç.")
            return
        }
        let open: ([UIImage]) -> Void = { [weak self] images in
            guard let self, let image = images.first else { return }
            self.openEditor(nil, photo: image)
        }
        if camera { ImagePicking.camera(from: self, onPick: open) } else { ImagePicking.photos(from: self, limit: 1, onPick: open) }
    }

    private func openEditor(_ product: BrandProduct?, photo: UIImage? = nil) {
        let editor = ProductEditorViewController(app: app, product: product, newPhoto: photo)
        editor.onSaved = { [weak self] saved in self?.model.saved(saved) }
        editor.onDeleted = { [weak self] _ in Task { await self?.model.load() } }
        presentSheet(editor, detents: [.large()])
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { model.products.count }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        if let error = model.error { return error }
        guard !model.products.isEmpty else { return nil }
        return "Ürünler Mac'teki marka profilinde de görünür; yapay zekâ postlarda onları adıyla anar."
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let product = model.products[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = product.name
        let details = [product.category, product.description].filter { !$0.isEmpty }.joined(separator: " · ")
        content.secondaryText = details.isEmpty ? (product.tags.isEmpty ? nil : ProductTags.text(product.tags)) : details
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.secondaryTextProperties.numberOfLines = 2
        content.textProperties.font = IOSTheme.font(16, .medium)
        content.directionalLayoutMargins.leading = 72
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        let cover = IOSAssetImageView(store: app.images, assetId: product.coverAssetId, cornerRadius: 8, displayWidth: 48)
        cover.backgroundColor = IOSTheme.fill
        cell.contentView.addSubview(cover)
        NSLayoutConstraint.activate([
            cover.leadingAnchor.constraint(equalTo: cell.contentView.leadingAnchor, constant: 14),
            cover.centerYAnchor.constraint(equalTo: cell.contentView.centerYAnchor),
            cover.widthAnchor.constraint(equalToConstant: 48),
            cover.heightAnchor.constraint(equalToConstant: 48),
        ])
        if product.coverAssetId == nil {
            let icon = UIImageView(image: UIImage(systemName: "shippingbox"))
            icon.tintColor = IOSTheme.textTertiary
            icon.translatesAutoresizingMaskIntoConstraints = false
            cover.addSubview(icon)
            NSLayoutConstraint.activate([icon.centerXAnchor.constraint(equalTo: cover.centerXAnchor), icon.centerYAnchor.constraint(equalTo: cover.centerYAnchor)])
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat { 72 }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        openEditor(model.products[indexPath.row])
    }

    override func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        let product = model.products[indexPath.row]
        let delete = UIContextualAction(style: .destructive, title: "Sil") { [weak self] _, _, done in
            guard let self else { return done(false) }
            self.confirm("“\(product.name)” silinsin mi?", message: "Ürün kalıcı olarak silinir; fotoğrafları medyada kalır.", action: "Sil") {
                Task {
                    if let error = await self.model.delete(product) { self.presentError(error) }
                }
            }
            done(true)
        }
        return UISwipeActionsConfiguration(actions: [delete])
    }
}

/// Add or edit one product. With `newPhoto` the photo is uploaded at once and the form fills
/// its empty fields from what the Mac reads on it.
final class ProductEditorViewController: UIViewController, UITextFieldDelegate {
    private unowned let app: IOSAppModel
    private let product: BrandProduct?
    private let brandId: EntityID?
    private var photoIds: [EntityID]
    private var pendingPhoto: UIImage?
    /// The photo whose reading fills the form (the quick add's, or one picked in Medya).
    private var analyzeAssetId: EntityID?
    var onSaved: ((BrandProduct) -> Void)?
    var onDeleted: ((BrandProduct) -> Void)?

    private let photosStack = UIStackView.h([], spacing: 8)
    private let nameField = UITextField()
    private let categoryField = UITextField()
    private let tagsField = UITextField()
    private let descriptionView = UITextView()
    private let notesView = UITextView()
    private let hintLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    private var uploading: Double?
    private var isSaving = false
    private var analysisTask: Task<Void, Never>?

    init(app: IOSAppModel, product: BrandProduct?, newPhoto: UIImage? = nil, photoAssetIds: [EntityID] = [], analyzeAssetId: EntityID? = nil) {
        self.app = app
        self.product = product
        self.brandId = product?.brandId ?? app.currentBrandId
        self.photoIds = product?.imageAssetIds ?? photoAssetIds
        self.pendingPhoto = newPhoto
        self.analyzeAssetId = analyzeAssetId
        super.init(nibName: nil, bundle: nil)
        title = product == nil ? "Yeni ürün" : "Ürün"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        if isBeingDismissed || navigationController?.isBeingDismissed == true { analysisTask?.cancel() }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Kaydet", style: .prominent, target: self, action: #selector(save))

        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        let photosScroll = UIScrollView()
        photosScroll.translatesAutoresizingMaskIntoConstraints = false
        photosScroll.showsHorizontalScrollIndicator = false
        photosScroll.addSubview(photosStack)
        NSLayoutConstraint.activate([
            photosStack.leadingAnchor.constraint(equalTo: photosScroll.contentLayoutGuide.leadingAnchor),
            photosStack.trailingAnchor.constraint(equalTo: photosScroll.contentLayoutGuide.trailingAnchor),
            photosStack.topAnchor.constraint(equalTo: photosScroll.contentLayoutGuide.topAnchor),
            photosStack.bottomAnchor.constraint(equalTo: photosScroll.contentLayoutGuide.bottomAnchor),
            photosStack.heightAnchor.constraint(equalTo: photosScroll.frameLayoutGuide.heightAnchor),
            photosScroll.heightAnchor.constraint(equalToConstant: 100),
        ])

        style(nameField, placeholder: "Ürün adı", text: product?.name)
        style(categoryField, placeholder: "Kategori (örn. Gübre)", text: product?.category)
        style(tagsField, placeholder: "Etiketler, virgülle (örn. organik, 25 kg)", text: product.map { ProductTags.text($0.tags) })
        style(descriptionView, text: product?.description)
        style(notesView, text: product?.notes)
        nameField.returnKeyType = .next
        nameField.autocapitalizationType = .words

        var rows: [UIView] = [
            section("Fotoğraflar", photosScroll, footer: "İlki kapak olur. Uzun basarak kaldırabilir ya da kapak yapabilirsin."),
            hintLabel,
            section("Ad", nameField),
            section("Kategori", categoryField),
            section("Kısa açıklama", descriptionView),
            section("Etiketler", tagsField),
            section("Notlar", notesView, footer: "Postlarda neyin öne çıkacağı, nelerden kaçınılacağı."),
        ]
        if product != nil {
            rows.append(UIButton.studioPill(title: "Ürünü sil", kind: .plain, image: "trash") { [weak self] in self?.deleteProduct() })
        }
        let stack = UIStackView.v(rows, spacing: 18)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.leadingAnchor.constraint(equalTo: scroll.frameLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: scroll.frameLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
        ])
        hintLabel.isHidden = true
        renderPhotos()

        if let photo = pendingPhoto {
            pendingPhoto = nil
            upload(photo, analyze: true)
        } else if let analyzeAssetId {
            readPhoto(analyzeAssetId)
        }
    }

    // MARK: Form pieces

    private func style(_ field: UITextField, placeholder: String, text: String?) {
        field.translatesAutoresizingMaskIntoConstraints = false
        field.placeholder = placeholder
        field.text = text
        field.font = IOSTheme.font(16)
        field.backgroundColor = IOSTheme.elevated
        field.layer.cornerRadius = 12
        field.layer.cornerCurve = .continuous
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        field.leftViewMode = .always
        field.clearButtonMode = .whileEditing
        field.delegate = self
        field.heightAnchor.constraint(equalToConstant: 46).isActive = true
    }

    private func style(_ textView: UITextView, text: String?) {
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.text = text
        textView.font = IOSTheme.font(16)
        textView.backgroundColor = IOSTheme.elevated
        textView.layer.cornerRadius = 12
        textView.layer.cornerCurve = .continuous
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        textView.isScrollEnabled = false
        textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 84).isActive = true
    }

    private func section(_ title: String, _ content: UIView, footer: String? = nil) -> UIView {
        var views: [UIView] = [UILabel.studio(title, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), content]
        if let footer { views.append(UILabel.studio(footer, size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1)) }
        return UIStackView.v(views, spacing: 6)
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if textField === nameField { categoryField.becomeFirstResponder() } else { textField.resignFirstResponder() }
        return true
    }

    // MARK: Photos

    private func renderPhotos() {
        photosStack.removeAllArranged()
        for (index, id) in photoIds.enumerated() {
            let image = IOSAssetImageView(store: app.images, assetId: id, cornerRadius: 12, displayWidth: 80)
            image.backgroundColor = IOSTheme.fill
            image.isUserInteractionEnabled = false
            let button = UIButton(type: .custom)
            button.translatesAutoresizingMaskIntoConstraints = false
            button.addSubview(image)
            image.pin(to: button)
            button.widthAnchor.constraint(equalToConstant: 80).isActive = true
            button.menu = photoMenu(id, index: index, source: image)
            button.showsMenuAsPrimaryAction = true
            button.accessibilityLabel = index == 0 ? "Kapak fotoğrafı" : "Fotoğraf \(index + 1)"
            photosStack.addArrangedSubview(button)
        }
        if let uploading {
            let box = UIView()
            box.translatesAutoresizingMaskIntoConstraints = false
            box.backgroundColor = IOSTheme.fill
            box.layer.cornerRadius = 12
            let ring = UsageRingView(size: 26)
            ring.fraction = max(0.05, uploading)
            box.addSubview(ring)
            NSLayoutConstraint.activate([
                box.widthAnchor.constraint(equalToConstant: 80),
                ring.centerXAnchor.constraint(equalTo: box.centerXAnchor),
                ring.centerYAnchor.constraint(equalTo: box.centerYAnchor),
            ])
            box.isAccessibilityElement = true
            box.accessibilityLabel = "Fotoğraf yükleniyor"
            photosStack.addArrangedSubview(box)
        }
        if photoIds.count < ProductLimits.maxImages, uploading == nil {
            let add = UIButton(type: .system)
            add.translatesAutoresizingMaskIntoConstraints = false
            add.setImage(UIImage(systemName: "plus"), for: .normal)
            add.tintColor = IOSTheme.textSecondary
            add.backgroundColor = IOSTheme.fill
            add.layer.cornerRadius = 12
            add.accessibilityLabel = "Fotoğraf ekle"
            add.widthAnchor.constraint(equalToConstant: 80).isActive = true
            add.showsMenuAsPrimaryAction = true
            var items: [UIMenuElement] = []
            if ImagePicking.cameraAvailable {
                items.append(UIAction(title: "Fotoğraf çek", image: UIImage(systemName: "camera")) { [weak self] _ in
                    guard let self else { return }
                    ImagePicking.camera(from: self) { images in images.first.map { self.upload($0, analyze: self.photoIds.isEmpty) } }
                })
            }
            items.append(UIAction(title: "Fotoğraflar'dan seç", image: UIImage(systemName: "photo")) { [weak self] _ in
                guard let self else { return }
                ImagePicking.photos(from: self, limit: 1) { images in images.first.map { self.upload($0, analyze: self.photoIds.isEmpty) } }
            })
            add.menu = UIMenu(children: items)
            photosStack.addArrangedSubview(add)
        }
    }

    private func photoMenu(_ id: EntityID, index: Int, source: UIView) -> UIMenu {
        var items: [UIMenuElement] = [
            UIAction(title: "Göster", image: UIImage(systemName: "eye")) { [weak self, weak source] _ in
                guard let self else { return }
                let items = self.photoIds.enumerated().map { PhotoViewerItem(assetId: $1, title: $0 == 0 ? "Kapak fotoğrafı" : "Fotoğraf \($0 + 1)", aspect: nil) }
                let start = self.photoIds.firstIndex(of: id) ?? 0
                PhotoViewerViewController(images: self.app.images, items: items, index: start, sourceFor: { _ in source }).open(from: self)
            },
        ]
        if index > 0 {
            items.append(UIAction(title: "Kapak yap", image: UIImage(systemName: "star")) { [weak self] _ in
                guard let self else { return }
                self.photoIds.removeAll { $0 == id }
                self.photoIds.insert(id, at: 0)
                self.renderPhotos()
            })
        }
        items.append(UIAction(title: "Kaldır", image: UIImage(systemName: "minus.circle"), attributes: .destructive) { [weak self] _ in
            self?.photoIds.removeAll { $0 == id }
            self?.renderPhotos()
        })
        return UIMenu(children: items)
    }

    private func upload(_ image: UIImage, analyze: Bool) {
        guard let brandId else { return }
        let imported: IOSImageImport.Imported
        do {
            imported = try IOSImageImport.from(image: image, filename: "urun.jpg")
        } catch {
            presentError(IOSAppModel.describe(error))
            return
        }
        uploading = 0
        renderPhotos()
        let service = app.dataService
        Task {
            do {
                let asset = try await service.uploadImage(imported.file, brandId: brandId) { progress in
                    Task { @MainActor in
                        guard self.uploading != nil else { return }
                        self.uploading = progress
                        self.renderPhotos()
                    }
                }
                app.images.seed(imported.thumbnail, for: asset.id)
                uploading = nil
                photoIds.append(asset.id)
                renderPhotos()
                if analyze { readPhoto(asset.id) }
            } catch {
                uploading = nil
                renderPhotos()
                presentError(IOSAppModel.describe(error), title: "Fotoğraf yüklenemedi")
            }
        }
    }

    /// Wait (about 30 s) for the Mac to read the photo, then fill the empty fields.
    private func readPhoto(_ assetId: EntityID) {
        analyzeAssetId = assetId
        hint("Mac fotoğrafı okuyor; adı ve etiketleri önerecek…")
        let service = app.dataService
        analysisTask?.cancel()
        analysisTask = Task { [weak self] in
            for attempt in 0..<15 {
                if attempt > 0 { try? await Task.sleep(for: .seconds(2)) }
                guard !Task.isCancelled else { return }
                guard let asset = try? await service.asset(assetId), let analysis = asset.analysis else { continue }
                self?.apply(ProductSuggestion.from(analysis))
                return
            }
            self?.hint("Mac fotoğrafı henüz okumadı; alanları sen doldurabilirsin.")
        }
    }

    private func apply(_ suggestion: ProductSuggestion) {
        guard !suggestion.isEmpty else {
            hint("Fotoğrafta okunacak bir yazı bulunamadı; alanları sen doldur.")
            return
        }
        var filled: [String] = []
        if let name = suggestion.name, nameField.text?.trimmingCharacters(in: .whitespaces).isEmpty ?? true {
            nameField.text = name
            filled.append("ad")
        }
        if let description = suggestion.description, descriptionView.text.trimmingCharacters(in: .whitespaces).isEmpty {
            descriptionView.text = description
            filled.append("açıklama")
        }
        if !suggestion.tags.isEmpty, tagsField.text?.trimmingCharacters(in: .whitespaces).isEmpty ?? true {
            tagsField.text = ProductTags.text(suggestion.tags)
            filled.append("etiketler")
        }
        hint(filled.isEmpty ? "Mac fotoğrafı okudu; alanlar zaten dolu." : "Mac fotoğraftan doldurdu (\(filled.joined(separator: ", "))); kaydetmeden önce kontrol et.")
    }

    private func hint(_ text: String) {
        hintLabel.text = text
        hintLabel.isHidden = false
    }

    // MARK: Save / delete

    private var form: BrandProductCreate {
        BrandProductCreate(
            name: nameField.text ?? "", description: descriptionView.text ?? "", category: categoryField.text ?? "",
            tags: ProductTags.parse(tagsField.text ?? ""), notes: notesView.text ?? "", imageAssetIds: photoIds)
    }

    @objc private func save() {
        guard !isSaving, let brandId else { return }
        let input = form
        if let problem = input.problem {
            presentError(problem)
            return
        }
        if uploading != nil {
            presentError("Fotoğraf yüklenince kaydedebilirsin.")
            return
        }
        isSaving = true
        navigationItem.rightBarButtonItem?.isEnabled = false
        let service = app.dataService
        Task {
            defer {
                isSaving = false
                navigationItem.rightBarButtonItem?.isEnabled = true
            }
            do {
                let saved: BrandProduct
                if let product {
                    let changes = BrandProductUpdate.changes(from: product, to: input)
                    saved = changes.isEmpty ? product : try await service.updateProduct(brandId: brandId, id: product.id, changes)
                } else {
                    saved = try await service.createProduct(brandId: brandId, input)
                }
                Haptics.success()
                onSaved?(saved)
                dismiss(animated: true)
            } catch {
                presentError(IOSAppModel.describe(error), title: "Kaydedilemedi")
            }
        }
    }

    private func deleteProduct() {
        guard let product else { return }
        confirm("“\(product.name)” silinsin mi?", message: "Ürün kalıcı olarak silinir; fotoğrafları medyada kalır.", action: "Sil") { [weak self] in
            guard let self else { return }
            Task {
                do {
                    try await self.app.dataService.deleteProduct(brandId: product.brandId, id: product.id)
                    self.onDeleted?(product)
                    self.dismiss(animated: true)
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                }
            }
        }
    }
}
