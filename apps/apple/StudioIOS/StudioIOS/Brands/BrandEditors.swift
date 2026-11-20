import StudioKit
import UIKit
import UniformTypeIdentifiers

// The sheets of the brand screens: a new brand and the brand's name / short name / language, a
// kit colour, a kit font, a long text (notes, voice, design rules, a sample's caption), and the
// Files picker for logos and fonts.

// MARK: - Form page

/// A sheet page with fields in a column, "Vazgeç" and a save button in the bar; the column
/// stays above the keyboard.
class BrandFormPage: UIViewController {
    let scroll = UIScrollView()
    let column = UIStackView.v([], spacing: 18)
    let errorLabel = UILabel.studio("", size: 13, color: .systemRed, lines: 0, style: .footnote)
    private let saveTitle: String
    private(set) var isBusy = false

    init(title: String, saveTitle: String = "Kaydet") {
        self.saveTitle = saveTitle
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        setBusy(false)
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        errorLabel.isHidden = true
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            column.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            column.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            column.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * IOSTheme.gutter),
        ])
    }

    func setBusy(_ busy: Bool) {
        isBusy = busy
        if busy {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else {
            let save = UIBarButtonItem(title: saveTitle, primaryAction: UIAction { [weak self] _ in self?.save() })
            save.style = .prominent
            navigationItem.rightBarButtonItem = save
        }
    }

    func show(_ problem: String?) {
        errorLabel.text = problem
        errorLabel.isHidden = problem == nil
        if problem != nil { Haptics.error() }
    }

    /// Overridden: what "Kaydet" does.
    func save() {}

    // Field factories

    static func field(_ text: String?, placeholder: String, mono: Bool = false) -> UITextField {
        let field = UITextField()
        field.translatesAutoresizingMaskIntoConstraints = false
        field.text = text
        field.placeholder = placeholder
        field.font = mono ? .monospacedSystemFont(ofSize: 16, weight: .regular) : IOSTheme.font(16)
        field.textColor = IOSTheme.textPrimary
        field.backgroundColor = IOSTheme.fill
        field.layer.cornerRadius = 12
        field.layer.cornerCurve = .continuous
        field.clearButtonMode = .whileEditing
        field.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        field.leftViewMode = .always
        field.heightAnchor.constraint(equalToConstant: 46).isActive = true
        return field
    }

    static func labeled(_ label: String, _ control: UIView, hint: String? = nil) -> UIView {
        var views: [UIView] = [UILabel.studio(label, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), control]
        if let hint { views.append(BrandUI.footnote(hint, color: IOSTheme.textTertiary)) }
        return UIStackView.v(views, spacing: 6)
    }
}

// MARK: - Brand form

/// "Yeni marka" and the brand's name, short name and language (Genel).
final class BrandFormViewController: BrandFormPage {
    enum Mode {
        case create
        case edit(Brand)
    }

    private let mode: Mode
    private let onSave: @MainActor (_ name: String, _ slug: String, _ language: String) async -> String?
    private let nameField: UITextField
    private let slugField: UITextField
    private var language: String
    private let languageButton = UIButton(type: .system)

    init(mode: Mode, onSave: @escaping @MainActor (_ name: String, _ slug: String, _ language: String) async -> String?) {
        self.mode = mode
        self.onSave = onSave
        let brand: Brand? = if case .edit(let brand) = mode { brand } else { nil }
        nameField = Self.field(brand?.name, placeholder: "Örn. MTM Agro")
        slugField = Self.field(brand?.slug, placeholder: "mtm-agro", mono: true)
        language = brand?.defaultLanguage ?? "tr"
        super.init(title: brand == nil ? "Yeni marka" : "Marka", saveTitle: brand == nil ? "Oluştur" : "Kaydet")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        slugField.autocapitalizationType = .none
        slugField.autocorrectionType = .no
        nameField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.slugField.placeholder = Brand.slugify(self.nameField.text ?? "").isEmpty ? "mtm-agro" : Brand.slugify(self.nameField.text ?? "")
        }, for: .editingChanged)
        languageButton.configuration = UIButton.pillConfiguration(title: BrandLanguages.label(language), kind: .secondary, image: "chevron.up.chevron.down")
        languageButton.configuration?.imagePlacement = .trailing
        languageButton.showsMenuAsPrimaryAction = true
        languageButton.contentHorizontalAlignment = .leading
        refreshLanguageMenu()
        let isCreate = if case .create = mode { true } else { false }
        column.addArrangedSubview(Self.labeled("Marka adı", nameField, hint: "Sohbetlerde ve kartlarda görünen ad."))
        column.addArrangedSubview(Self.labeled("Kısa ad", slugField, hint: isCreate ? "Küçük harf, rakam ve tire; boş bırakılırsa addan üretilir." : "Küçük harf, rakam ve tire (mtm-agro)."))
        column.addArrangedSubview(Self.labeled("İçerik dili", UIStackView.h([languageButton, UIView.spacer()], spacing: 0), hint: "Postlar bu dilde yazılır."))
        column.addArrangedSubview(errorLabel)
        if isCreate {
            column.addArrangedSubview(BrandUI.footnote("Oluşunca seçili marka olur ve sayfası açılır: marka kitini doldurup AI ile analiz edebilirsin.", color: IOSTheme.textTertiary))
        }
        nameField.becomeFirstResponder()
    }

    private func refreshLanguageMenu() {
        languageButton.menu = UIMenu(children: BrandLanguages.all.map { option in
            UIAction(title: option.label, state: option.tag == language ? .on : .off) { [weak self] _ in
                guard let self else { return }
                self.language = option.tag
                self.languageButton.configuration?.title = option.label
                self.refreshLanguageMenu()
            }
        })
    }

    override func save() {
        guard !isBusy else { return }
        let name = (nameField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        var slug = (slugField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if case .create = mode {
            switch BrandOverview.newBrandInput(name: name, slug: slug, language: language) {
            case .failure(let problem): return show(problem.message)
            case .success(let input): slug = input.slug ?? slug
            }
        } else if slug.isEmpty {
            slug = Brand.slugify(name)
        }
        show(nil)
        setBusy(true)
        Task {
            let problem = await onSave(name, slug, language)
            setBusy(false)
            if let problem { show(problem) } else { dismiss(animated: true) }
        }
    }
}

// MARK: - Colour

/// One kit colour: the circle (a tap opens the system colour picker), its code, name and use.
/// `onDone(nil)` removes it.
final class BrandColorEditorViewController: BrandFormPage, UIColorPickerViewControllerDelegate {
    private let existing: BrandKitColor?
    private let onDone: (BrandKitColor?) -> Void
    private let circle = UIButton(type: .custom)
    private let hexField: UITextField
    private let nameField: UITextField
    private let useField: UITextField

    init(color: BrandKitColor?, defaultName: String, onDone: @escaping (BrandKitColor?) -> Void) {
        existing = color
        self.onDone = onDone
        hexField = Self.field(color?.hex ?? "#FF6A00", placeholder: "#RRGGBB", mono: true)
        nameField = Self.field(color?.name ?? defaultName, placeholder: "ana-vurgu", mono: true)
        useField = Self.field(color?.use, placeholder: "Kullanım (ana vurgu, zemin …)")
        super.init(title: color == nil ? "Yeni renk" : "Renk", saveTitle: color == nil ? "Ekle" : "Kaydet")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        hexField.autocapitalizationType = .allCharacters
        hexField.autocorrectionType = .no
        nameField.autocapitalizationType = .none
        nameField.autocorrectionType = .no
        circle.translatesAutoresizingMaskIntoConstraints = false
        circle.layer.cornerRadius = 48
        circle.layer.borderWidth = 1
        circle.layer.borderColor = IOSTheme.border.cgColor
        circle.accessibilityLabel = "Renk seç"
        NSLayoutConstraint.activate([circle.widthAnchor.constraint(equalToConstant: 96), circle.heightAnchor.constraint(equalToConstant: 96)])
        circle.addAction(UIAction { [weak self] _ in self?.pickColor() }, for: .touchUpInside)
        hexField.addAction(UIAction { [weak self] _ in self?.paint() }, for: .editingChanged)
        paint()
        let top = UIStackView.v([circle, BrandUI.footnote("Dokun: renk seçici", color: IOSTheme.textTertiary)], spacing: 8, alignment: .center)
        column.addArrangedSubview(top)
        column.addArrangedSubview(Self.labeled("Renk kodu", hexField))
        column.addArrangedSubview(Self.labeled("Ad", nameField, hint: "Küçük harf ve tire (ana-vurgu)."))
        column.addArrangedSubview(Self.labeled("Kullanım", useField, hint: "İsteğe bağlı."))
        column.addArrangedSubview(errorLabel)
        if existing != nil {
            let remove = UIButton.studioPill(title: "Rengi kaldır", kind: .plain, image: "trash") { [weak self] in
                self?.onDone(nil)
                self?.dismiss(animated: true)
            }
            remove.configuration?.baseForegroundColor = .systemRed
            column.addArrangedSubview(UIStackView.h([remove, UIView.spacer()], spacing: 0))
        }
    }

    private func paint() {
        circle.backgroundColor = BrandKitRules.normalizedHex(hexField.text ?? "").flatMap { UIColor(hexString: $0) } ?? IOSTheme.fill
    }

    private func pickColor() {
        let picker = UIColorPickerViewController()
        picker.supportsAlpha = false
        picker.selectedColor = circle.backgroundColor ?? .orange
        picker.delegate = self
        present(picker, animated: true)
    }

    func colorPickerViewController(_ viewController: UIColorPickerViewController, didSelect color: UIColor, continuously: Bool) {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        color.getRed(&r, green: &g, blue: &b, alpha: &a)
        let clamp = { (v: CGFloat) in min(max(Int((v * 255).rounded()), 0), 255) }
        hexField.text = String(format: "#%02X%02X%02X", clamp(r), clamp(g), clamp(b))
        paint()
    }

    override func save() {
        guard let hex = BrandKitRules.normalizedHex(hexField.text ?? "") else { return show("Renk #RRGGBB biçiminde olmalı.") }
        guard let name = BrandKitRules.colorName(nameField.text ?? "") else { return show("Renk adı küçük harfle başlamalı; harf, rakam ve tire içerebilir.") }
        let use = (useField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        onDone(BrandKitColor(name: name, hex: hex, use: use.isEmpty ? nil : use))
        dismiss(animated: true)
    }
}

// MARK: - Font

/// One kit font: a preview in its face, its family (the file's, or the Mac's installed name),
/// role and licence note. `onDone(nil)` removes it.
final class BrandFontEditorViewController: BrandFormPage {
    private var font: BrandKitFont
    private let fileName: String?
    private let preview: UIFont?
    private let onDone: (BrandKitFont?) -> Void
    private let familyField: UITextField
    private let licenseField: UITextField
    private let roles = UISegmentedControl(items: [BrandKitFontRole.display, .text, .any].map(BrandOverview.roleLabel))

    init(font: BrandKitFont, fileName: String?, preview: UIFont?, onDone: @escaping (BrandKitFont?) -> Void) {
        self.font = font
        self.fileName = fileName
        self.preview = preview
        self.onDone = onDone
        familyField = Self.field(font.family, placeholder: "Archivo")
        licenseField = Self.field(font.licenseNote, placeholder: "Lisans notu (nereden, ne izin veriyor)")
        super.init(title: "Yazı tipi")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        let sample = UILabel.studio("Aa Bb Çç Ğğ İı Şş\n0123456789", size: 30, lines: 0, style: .title1)
        sample.font = preview ?? IOSTheme.font(30, .semibold, style: .title1)
        column.addArrangedSubview(sample)
        let source = font.isSystem
            ? "Mac'te yüklü · \(BrandKitRules.stylesLabel(font)). Stiller Mac'teki yazı tipi seçicisinden seçilir."
            : "Dosya: \(fileName ?? "font dosyası")"
        column.addArrangedSubview(BrandUI.footnote(source + (preview == nil ? " · Bu iPhone'da önizlenemiyor." : "")))
        familyField.autocorrectionType = .no
        column.addArrangedSubview(Self.labeled(font.isSystem ? "Mac'teki adı" : "Aile adı", familyField, hint: "Harf, rakam, boşluk ve tire."))
        roles.selectedSegmentIndex = switch font.role {
        case .display: 0
        case .text: 1
        default: 2
        }
        column.addArrangedSubview(Self.labeled("Rol", roles))
        column.addArrangedSubview(Self.labeled("Lisans notu", licenseField))
        column.addArrangedSubview(errorLabel)
        let remove = UIButton.studioPill(title: "Yazı tipini kaldır", kind: .plain, image: "trash") { [weak self] in
            self?.onDone(nil)
            self?.dismiss(animated: true)
        }
        remove.configuration?.baseForegroundColor = .systemRed
        column.addArrangedSubview(UIStackView.h([remove, UIView.spacer()], spacing: 0))
    }

    override func save() {
        let family = (familyField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard BrandKitRules.isValidFamily(family) else { return show("Font adı yalnızca harf, rakam, boşluk ve tire içerebilir.") }
        font.family = family
        font.role = [BrandKitFontRole.display, .text, .any][max(roles.selectedSegmentIndex, 0)]
        font.licenseNote = (licenseField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        onDone(font)
        dismiss(animated: true)
    }
}

// MARK: - Long text

/// Notes, a profile draft's voice or design rules, a sample's caption. `onSave` returns a
/// problem to show, or nil to close.
final class BrandTextEditorViewController: UIViewController {
    private let text: String
    private let placeholder: String
    private let mono: Bool
    private let onSave: @MainActor (String) async -> String?
    private let textView = UITextView()
    private let placeholderLabel = UILabel.studio("", size: 16, color: IOSTheme.textTertiary, lines: 0, style: .body)

    init(title: String, text: String, placeholder: String, mono: Bool = false, onSave: @escaping @MainActor (String) async -> String?) {
        self.text = text
        self.placeholder = placeholder
        self.mono = mono
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        setSaving(false)
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.text = text
        textView.font = mono ? .monospacedSystemFont(ofSize: 14, weight: .regular) : IOSTheme.font(16)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = IOSTheme.textPrimary
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 24, right: 12)
        textView.autocorrectionType = mono ? .no : .default
        textView.smartQuotesType = mono ? .no : .default
        view.addSubview(textView)
        NSLayoutConstraint.activate([
            textView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            textView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            textView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            textView.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        placeholderLabel.text = placeholder
        placeholderLabel.isHidden = !text.isEmpty
        view.addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.topAnchor.constraint(equalTo: textView.topAnchor, constant: 16),
            placeholderLabel.leadingAnchor.constraint(equalTo: textView.leadingAnchor, constant: 17),
            placeholderLabel.trailingAnchor.constraint(equalTo: textView.trailingAnchor, constant: -17),
        ])
        NotificationCenter.default.addObserver(forName: UITextView.textDidChangeNotification, object: textView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.placeholderLabel.isHidden = !(self?.textView.text.isEmpty ?? true) }
        }
        textView.becomeFirstResponder()
    }

    private func setSaving(_ saving: Bool) {
        if saving {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItem = UIBarButtonItem(customView: spinner)
        } else {
            let save = UIBarButtonItem(title: "Kaydet", primaryAction: UIAction { [weak self] _ in self?.save() })
            save.style = .prominent
            navigationItem.rightBarButtonItem = save
        }
    }

    private func save() {
        let value = textView.text ?? ""
        guard value != text else { return dismiss(animated: true) }
        setSaving(true)
        Task {
            let problem = await onSave(value)
            setSaving(false)
            if let problem { presentError(problem) } else { dismiss(animated: true) }
        }
    }
}

// MARK: - Files

/// Logo files (PNG, SVG, JPEG, WebP) or font files (WOFF2, WOFF, TTF, OTF) from the Files app,
/// as they go to the Mac.
@MainActor
final class BrandFilePicker: NSObject, UIDocumentPickerDelegate {
    private var onPick: (([UploadFile]) -> Void)?
    private var retainSelf: BrandFilePicker?
    private var fonts = false
    private weak var presenter: UIViewController?

    static let logoTypes: [String: String] = ["png": "image/png", "svg": "image/svg+xml", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"]
    static let fontTypes: [String: String] = ["woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf", "otf": "font/otf"]

    static func pick(from presenter: UIViewController, fonts: Bool, onPick: @escaping ([UploadFile]) -> Void) {
        let extensions = Array((fonts ? fontTypes : logoTypes).keys)
        var types = extensions.compactMap { UTType(filenameExtension: $0) }
        types.append(fonts ? .font : .image)
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: types, asCopy: true)
        picker.allowsMultipleSelection = true
        let handler = BrandFilePicker()
        handler.onPick = onPick
        handler.fonts = fonts
        handler.presenter = presenter
        handler.retainSelf = handler
        picker.delegate = handler
        presenter.present(picker, animated: true)
    }

    nonisolated func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        MainActor.assumeIsolated {
            let types = fonts ? Self.fontTypes : Self.logoTypes
            var files: [UploadFile] = []
            var refused: [String] = []
            for url in urls {
                let ext = url.pathExtension.lowercased()
                guard let mime = types[ext], let data = try? Data(contentsOf: url), data.count <= AssetMimeRules.imageMaxBytes else {
                    refused.append(url.lastPathComponent)
                    continue
                }
                files.append(UploadFile(filename: url.lastPathComponent, mimeType: mime, data: data))
            }
            if !refused.isEmpty {
                presenter?.presentError("Kullanılamayan dosya: \(refused.joined(separator: ", ")). \(fonts ? "WOFF2, WOFF, TTF ya da OTF" : "PNG, SVG, JPEG ya da WebP") seç (en fazla 20 MB).")
            }
            onPick?(files)
            retainSelf = nil
        }
    }

    nonisolated func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        MainActor.assumeIsolated { retainSelf = nil }
    }
}
