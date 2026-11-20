import StudioKit
import UIKit

// Şablonlar' sheets (N9): "Bu şablonla yeni post" (typed texts and pictures per field, or a
// subject the AI writes them from) and a template's name and field settings.

/// `/media/<asset>.<ext>` → the asset id (an image field's example picture).
private func mediaAssetId(_ example: String) -> EntityID? {
    guard example.hasPrefix("/media/") else { return nil }
    let file = String(example.dropFirst("/media/".count))
    return (file as NSString).deletingPathExtension.removingPercentEncoding
}

// MARK: - Bu şablonla yeni post

final class TemplateUseViewController: BrandFormPage {
    private unowned let app: IOSAppModel
    private let model: BrandPageModel
    private let template: ContentTemplate
    private var form: TemplateRules.FillForm
    private let fields = UIStackView.v([], spacing: 18)
    private let modes = UISegmentedControl(items: ["Elle doldur", "AI doldursun"])
    private var uploading: Set<String> = []

    init(app: IOSAppModel, model: BrandPageModel, template: ContentTemplate) {
        self.app = app
        self.model = model
        self.template = template
        self.form = TemplateRules.FillForm(template: template)
        super.init(title: "Bu şablonla yeni post", saveTitle: "Oluştur")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let preview = IOSAssetImageView(store: app.images, assetId: template.previewAssetId, cornerRadius: 10, displayWidth: 96)
        preview.backgroundColor = IOSTheme.postMuted
        NSLayoutConstraint.activate([
            preview.widthAnchor.constraint(equalToConstant: 96),
            preview.heightAnchor.constraint(equalTo: preview.widthAnchor, multiplier: CGFloat(template.height) / CGFloat(max(template.width, 1))),
        ])
        let info = UIStackView.v([
            UILabel.studio(template.name, size: 17, weight: .semibold, lines: 2, style: .headline),
            BrandUI.footnote(TemplateRules.line(template)),
            BrandUI.footnote("Yerleşim aynen kalır; yalnızca metinler ve görseller değişir.", color: IOSTheme.textTertiary),
        ], spacing: 4)
        column.addArrangedSubview(UIStackView.h([preview, info], spacing: 14, alignment: .top))
        let titleField = Self.field(form.title, placeholder: "Postun başlığı")
        titleField.addAction(UIAction { [weak self, weak titleField] _ in self?.form.title = titleField?.text ?? "" }, for: .editingChanged)
        column.addArrangedSubview(Self.labeled("Başlık", titleField))
        modes.selectedSegmentIndex = 0
        modes.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.form.mode = self.modes.selectedSegmentIndex == 1 ? .ai : .manual
            self.buildFields()
        }, for: .valueChanged)
        column.addArrangedSubview(modes)
        column.addArrangedSubview(fields)
        let autoFit = UISwitch()
        autoFit.isOn = form.autoFit
        autoFit.onTintColor = IOSTheme.accent
        autoFit.addAction(UIAction { [weak self, weak autoFit] _ in self?.form.autoFit = autoFit?.isOn ?? true }, for: .valueChanged)
        let autoFitLabel = UILabel.studio("Sığmayan metni küçült (sınırlar içinde)", size: 15, lines: 0, style: .subheadline)
        column.addArrangedSubview(UIStackView.h([autoFitLabel, UIView.spacer(), autoFit], spacing: 12))
        column.addArrangedSubview(errorLabel)
        buildFields()
    }

    private func buildFields() {
        fields.removeAllArranged()
        if form.mode == .ai {
            let brief = Self.area(form.brief, placeholder: "Post ne anlatsın? Ör. Kış öncesi bor ve çinko hatırlatması, bayilere yönlendir.") { [weak self] text in self?.form.brief = text }
            fields.addArrangedSubview(Self.labeled("Konu", brief, hint: "AI her alanı şablondaki metin uzunluğunda yazar; açıklamayı da yazar."))
        } else {
            let texts = template.fillableFields(.text)
            for field in texts {
                let count = UILabel.studio("", size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1)
                count.font = IOSTheme.monoDigits(12)
                let update: (String) -> Void = { [weak self, weak count] text in
                    self?.form.values[field.key] = text
                    let state = TemplateRules.count(field, text)
                    count?.text = state?.text
                    count?.textColor = state?.over == true ? IOSTheme.accent : IOSTheme.textTertiary
                    count?.isHidden = state == nil
                }
                let value = form.values[field.key] ?? ""
                let input: UIView
                if field.multiline || field.example.count > 60 {
                    input = Self.area(value, placeholder: field.example, onChange: update)
                } else {
                    let line = Self.field(value, placeholder: field.example)
                    line.addAction(UIAction { [weak line] _ in update(line?.text ?? "") }, for: .editingChanged)
                    input = line
                }
                update(value)
                fields.addArrangedSubview(UIStackView.v([
                    UILabel.studio(field.label, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), input, count,
                ], spacing: 6))
            }
            if !texts.isEmpty {
                fields.addArrangedSubview(BrandUI.footnote("Boş bırakılan alan şablondaki metni korur.", color: IOSTheme.textTertiary))
            }
        }
        for field in template.fillableFields(.image) {
            fields.addArrangedSubview(imageRow(field))
        }
    }

    /// A picture field: the picture it will use, and where to take a new one from.
    private func imageRow(_ field: TemplateField) -> UIView {
        let picked = form.images[field.key]
        let thumb = IOSAssetImageView(store: app.images, assetId: picked ?? mediaAssetId(field.example), cornerRadius: 8, displayWidth: 56)
        thumb.alpha = picked == nil ? 0.55 : 1
        NSLayoutConstraint.activate([thumb.widthAnchor.constraint(equalToConstant: 56), thumb.heightAnchor.constraint(equalToConstant: 56)])
        let state = uploading.contains(field.key) ? "Yükleniyor…" : (picked == nil ? "Şablondaki görsel kalır." : "Yeni görsel seçildi.")
        let line = BrandUI.footnote(state + (field.ratio.map { " · \($0)" } ?? ""))
        var actions: [UIMenuElement] = [
            UIAction(title: "Medyadan seç", image: UIImage(systemName: "photo.on.rectangle")) { [weak self] _ in self?.pickFromMedia(field) },
            UIAction(title: "Fotoğraflardan yükle", image: UIImage(systemName: "photo")) { [weak self] _ in self?.uploadPhoto(field) },
        ]
        if picked != nil {
            actions.append(UIAction(title: "Şablondaki kalsın", image: UIImage(systemName: "arrow.uturn.backward")) { [weak self] _ in
                self?.form.images[field.key] = nil
                self?.buildFields()
            })
        }
        let choose = BrandUI.menuPill("Seç", image: "photo", menu: UIMenu(children: actions))
        return UIStackView.v([
            UILabel.studio(field.label, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote),
            UIStackView.h([thumb, line, UIView.spacer(), choose], spacing: 12),
        ], spacing: 6)
    }

    private func pickFromMedia(_ field: TemplateField) {
        let picker = BrandMediaPickerViewController(app: app, brandId: template.brandId, selected: form.images[field.key]) { [weak self] assetId in
            self?.form.images[field.key] = assetId
            self?.buildFields()
        }
        navigationController?.pushViewController(picker, animated: true)
    }

    private func uploadPhoto(_ field: TemplateField) {
        ImagePicking.photos(from: self, limit: 1) { [weak self] images in
            guard let self, let image = images.first, let imported = try? IOSImageImport.from(image: image) else { return }
            self.uploading.insert(field.key)
            self.buildFields()
            Task {
                do {
                    let asset = try await self.app.dataService.uploadImage(imported.file, brandId: self.template.brandId) { _ in }
                    self.form.images[field.key] = asset.id
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                }
                self.uploading.remove(field.key)
                self.buildFields()
            }
        }
    }

    override func save() {
        guard !isBusy else { return }
        if let problem = TemplateRules.problem(form) { return show(problem) }
        guard uploading.isEmpty else { return show("Görsel yüklenmesini bekle.") }
        show(nil)
        setBusy(true)
        Task {
            switch await model.useTemplate(template, TemplateRules.useInput(template, form)) {
            case .success(let result):
                Haptics.success()
                let app = self.app
                dismiss(animated: true) {
                    app.open(.post(result.content.id))
                }
            case .failure(let problem):
                setBusy(false)
                show(problem.message)
            }
        }
    }

    /// A growing multi-line field on the fill colour.
    static func area(_ text: String, placeholder: String, onChange: @escaping (String) -> Void) -> UIView {
        let view = PlaceholderTextView(placeholder: placeholder)
        view.text = text
        view.onChange = onChange
        return view
    }
}

/// A text view that grows with its text and shows a placeholder while empty.
final class PlaceholderTextView: UITextView, UITextViewDelegate {
    var onChange: ((String) -> Void)?
    private let placeholderLabel = UILabel.studio("", size: 16, color: IOSTheme.textTertiary, lines: 0, style: .body)

    init(placeholder: String) {
        super.init(frame: .zero, textContainer: nil)
        translatesAutoresizingMaskIntoConstraints = false
        isScrollEnabled = false
        font = IOSTheme.font(16)
        adjustsFontForContentSizeCategory = true
        textColor = IOSTheme.textPrimary
        backgroundColor = IOSTheme.fill
        layer.cornerRadius = 12
        layer.cornerCurve = .continuous
        textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        heightAnchor.constraint(greaterThanOrEqualToConstant: 96).isActive = true
        delegate = self
        placeholderLabel.text = placeholder
        addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.topAnchor.constraint(equalTo: topAnchor, constant: 12),
            placeholderLabel.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 13),
            placeholderLabel.widthAnchor.constraint(equalTo: widthAnchor, constant: -26),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var text: String! {
        didSet { placeholderLabel.isHidden = !(text ?? "").isEmpty }
    }

    func textViewDidChange(_ textView: UITextView) {
        placeholderLabel.isHidden = !textView.text.isEmpty
        onChange?(textView.text)
    }
}

// MARK: - Picking a picture from the brand's media

/// The brand's pictures in the Medya grid's three columns; a tap picks one.
final class BrandMediaPickerViewController: UIViewController {
    private unowned let app: IOSAppModel
    private let brandId: EntityID
    private let selected: EntityID?
    private let onPick: (EntityID) -> Void
    private let scroll = UIScrollView()
    private let content = UIStackView.v([], spacing: 0)

    init(app: IOSAppModel, brandId: EntityID, selected: EntityID?, onPick: @escaping (EntityID) -> Void) {
        self.app = app
        self.brandId = brandId
        self.selected = selected
        self.onPick = onPick
        super.init(nibName: nil, bundle: nil)
        title = "Medyadan seç"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
        let spinner = UIActivityIndicatorView(style: .medium)
        spinner.startAnimating()
        content.addArrangedSubview(BrandUI.inset(spinner, top: 40))
        Task { await load() }
    }

    private func load() async {
        let assets: [Asset]
        do {
            assets = try await app.dataService.assets(brandId: brandId, kind: .image)
                .filter { $0.deletedAt == nil && AssetMimeRules.serverImageTypes.contains($0.mimeType) }
        } catch {
            content.removeAllArranged()
            content.addArrangedSubview(BrandUI.inset(BrandUI.footnote(IOSAppModel.describe(error), color: .systemRed), top: 20))
            return
        }
        content.removeAllArranged()
        guard !assets.isEmpty else {
            content.addArrangedSubview(BrandUI.inset(BrandUI.footnote("Markanın medyasında görsel yok; Medya'dan yükle ya da Fotoğraflar'dan seç."), top: 20))
            return
        }
        let tiles: [UIView] = assets.map { asset in
            let tile = TileButton()
            tile.backgroundColor = IOSTheme.fill
            let image = IOSAssetImageView(store: app.images, assetId: asset.id, displayWidth: PostGridCell.displayWidth)
            image.isUserInteractionEnabled = false
            tile.addSubview(image)
            image.pin(to: tile)
            if asset.id == selected {
                tile.layer.borderWidth = 3
                tile.layer.borderColor = IOSTheme.accent.cgColor
            }
            tile.accessibilityLabel = asset.originalFilename ?? "Görsel"
            tile.addAction(UIAction { [weak self] _ in
                Haptics.selection()
                self?.onPick(asset.id)
                self?.navigationController?.popViewController(animated: true)
            }, for: .touchUpInside)
            return tile
        }
        content.addArrangedSubview(TileGridView(columns: 3, ratio: 1, tiles: tiles))
    }
}

// MARK: - Ad ve alanlar

/// A template's name and fields: a field's label, locked (keeps the template's), auto-fit.
final class TemplateSettingsViewController: BrandFormPage {
    private let model: BrandPageModel
    private let template: ContentTemplate
    private var fields: [TemplateField]
    private let nameField: UITextField

    init(model: BrandPageModel, template: ContentTemplate) {
        self.model = model
        self.template = template
        self.fields = template.fields
        nameField = Self.field(template.name, placeholder: "Şablonun adı")
        super.init(title: "Şablon ayarları")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        column.addArrangedSubview(Self.labeled("Ad", nameField))
        column.addArrangedSubview(BrandUI.footnote("\(TemplateRules.line(template)) · \(TemplateRules.uses(template)) · Kaynak: “\(template.source.title)” v\(template.source.version)"))
        for field in fields {
            column.addArrangedSubview(BrandUI.hairline())
            let label = Self.field(field.label, placeholder: field.key)
            label.addAction(UIAction { [weak self, weak label] _ in self?.change(field.key) { $0.label = label?.text ?? "" } }, for: .editingChanged)
            let kind = UILabel.studio(field.kind == .image ? "Görsel" : "Metin", size: 12, weight: .semibold, color: IOSTheme.textSecondary, style: .caption1)
            kind.setContentHuggingPriority(.required, for: .horizontal)
            var views: [UIView] = [
                UIStackView.h([label, kind], spacing: 10),
                BrandUI.footnote(field.kind == .text ? "Şablonda: “\(field.example)”" : "Görsel yuvası", color: IOSTheme.textTertiary),
                toggle("Sabit (şablondaki kalsın)", on: field.locked) { [weak self] on in self?.change(field.key) { $0.locked = on } },
            ]
            if field.kind == .text {
                views.append(toggle("Sığmazsa küçült", on: field.autoFit) { [weak self] on in self?.change(field.key) { $0.autoFit = on } })
            }
            column.addArrangedSubview(UIStackView.v(views, spacing: 8))
        }
        column.addArrangedSubview(errorLabel)
    }

    private func toggle(_ title: String, on: Bool, change: @escaping (Bool) -> Void) -> UIView {
        let control = UISwitch()
        control.isOn = on
        control.onTintColor = IOSTheme.accent
        control.accessibilityLabel = title
        control.addAction(UIAction { [weak control] _ in change(control?.isOn ?? false) }, for: .valueChanged)
        return UIStackView.h([UILabel.studio(title, size: 15, lines: 0, style: .subheadline), UIView.spacer(), control], spacing: 12)
    }

    private func change(_ key: String, _ edit: (inout TemplateField) -> Void) {
        guard let index = fields.firstIndex(where: { $0.key == key }) else { return }
        edit(&fields[index])
    }

    override func save() {
        guard !isBusy else { return }
        let name = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return show("Şablona bir ad ver.") }
        let changed = fields.compactMap { field -> TemplateFieldUpdate? in
            guard let before = template.fields.first(where: { $0.key == field.key }),
                  before.label != field.label || before.locked != field.locked || before.autoFit != field.autoFit else { return nil }
            let label = field.label.trimmingCharacters(in: .whitespacesAndNewlines)
            return TemplateFieldUpdate(key: field.key, label: label.isEmpty ? field.key : label, autoFit: field.autoFit, locked: field.locked)
        }
        let input = ContentTemplateUpdate(name: name == template.name ? nil : name, fields: changed.isEmpty ? nil : changed)
        guard !input.isEmpty else { return dismiss(animated: true) }
        setBusy(true)
        Task {
            if let problem = await model.updateTemplate(template, input) {
                setBusy(false)
                show(problem)
            } else {
                Haptics.success()
                dismiss(animated: true)
            }
        }
    }
}
