import AppKit
import StudioKit

/// Form state of "Yeni marka" (shared rules with the first-run brand step).
@MainActor
@Observable
final class NewBrandModel {
    unowned let app: AppModel
    var name = "" {
        didSet { if !slugEdited { slug = Brand.slugify(name) } }
    }
    var slug = ""
    var slugEdited = false
    var language = "tr"
    var instagram = ""
    private(set) var isSaving = false
    var error: String?

    init(app: AppModel) {
        self.app = app
    }

    var problem: String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Marka adını yaz." }
        if trimmed.count > 120 { return "Marka adı en fazla 120 karakter olabilir." }
        if slug.count < 2 || slug != Brand.slugify(slug) { return "Kısa ad yalnızca küçük harf, rakam ve tire içerebilir (en az 2 karakter)." }
        return nil
    }

    /// Create the brand (and its Instagram account when given). Returns the brand on success.
    func create() async -> Brand? {
        guard problem == nil, !isSaving else { return nil }
        isSaving = true
        defer { isSaving = false }
        do {
            let brand = try await app.createNewBrand(name: name.trimmingCharacters(in: .whitespacesAndNewlines), slug: slug, language: language)
            let handle = BrandSettingsModel.normalizedHandle(instagram, platform: .instagram)
            if !handle.isEmpty {
                _ = try? await app.dataService.createSocialAccount(SocialAccountCreate(brandId: brand.id, platform: .instagram, handle: handle))
                await app.refreshAccounts()
            }
            error = nil
            return brand
        } catch {
            self.error = AppModel.describe(error)
            return nil
        }
    }
}

/// "+ Yeni marka…": name, short name, language and the Instagram handle; then the
/// brand settings open on the kit so the profile can be extracted.
final class NewBrandSheetController: NSViewController {
    private let model: NewBrandModel
    private let onDone: () -> Void

    private let nameField = BrandUI.field("Örn. MTM Agro")
    private let slugField = BrandUI.field("mtm-agro")
    private let instagramField = BrandUI.field("@kullaniciadi (isteğe bağlı)")
    private var languagePopUp: ClosurePopUp!
    private let problemLabel = BrandUI.note()
    private var createButton: PillButton!
    private var handlers: [FieldHandler] = []
    private var observation: ObservationToken?

    init(app: AppModel, onDone: @escaping () -> Void) {
        model = NewBrandModel(app: app)
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let nameHandler = FieldHandler(onChange: { [weak self] in self?.model.name = $0 }, onReturn: { [weak self] in self?.create() })
        let slugHandler = FieldHandler(onChange: { [weak self] value in
            self?.model.slugEdited = !value.isEmpty
            self?.model.slug = value
        }, onReturn: { [weak self] in self?.create() })
        let instagramHandler = FieldHandler(onChange: { [weak self] in self?.model.instagram = $0 }, onReturn: { [weak self] in self?.create() })
        handlers = [nameHandler, slugHandler, instagramHandler]
        nameField.delegate = nameHandler
        slugField.delegate = slugHandler
        instagramField.delegate = instagramHandler
        languagePopUp = ClosurePopUp(
            items: BrandLanguage.options.map { ($0.label, $0.tag as Any) },
            selected: { ($0 as? String) == "tr" },
            onPick: { [weak self] value in if let tag = value as? String { self?.model.language = tag } }
        )

        problemLabel.textColor = .systemRed
        let cancel = PillButton(title: "Vazgeç", kind: .secondary, height: 30) { [weak self] in self?.close() }
        createButton = PillButton(title: "Oluştur", kind: .primary, height: 30) { [weak self] in self?.create() }

        let stack = BrandUI.vstack(spacing: 8)
        stack.addArrangedSubview(BrandUI.title("Yeni marka"))
        BrandUI.addFull(BrandUI.note("Sonra marka kitini (örnek postlar, logo, font, renkler) ekleyip profilini çıkaracaksın."), to: stack)
        stack.setCustomSpacing(16, after: stack.arrangedSubviews.last!)
        stack.addArrangedSubview(BrandUI.caption("Marka adı"))
        BrandUI.addFull(nameField, to: stack)
        stack.setCustomSpacing(12, after: nameField)
        stack.addArrangedSubview(BrandUI.caption("Kısa ad"))
        BrandUI.addFull(slugField, to: stack)
        stack.setCustomSpacing(12, after: slugField)
        let languageColumn = BrandUI.vstack([BrandUI.caption("İçerik dili"), languagePopUp], spacing: 6)
        let instagramColumn = BrandUI.vstack([BrandUI.caption("Instagram"), instagramField], spacing: 6)
        instagramField.widthAnchor.constraint(equalTo: instagramColumn.widthAnchor).isActive = true
        BrandUI.addFull(BrandUI.hstack([languageColumn, instagramColumn], spacing: 16, align: .top), to: stack)
        BrandUI.addFull(problemLabel, to: stack)
        stack.setCustomSpacing(16, after: problemLabel)
        BrandUI.addFull(BrandUI.hstack([BrandUI.spacer(), cancel, createButton]), to: stack)

        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 440),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 22),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in self?.render() }
    }

    override func viewDidAppear() {
        super.viewDidAppear()
        view.window?.makeFirstResponder(nameField)
    }

    override func cancelOperation(_ sender: Any?) { close() }

    private func render() {
        if slugField.currentEditor() == nil || !model.slugEdited, slugField.stringValue != model.slug {
            slugField.stringValue = model.slug
        }
        let touched = !model.name.isEmpty
        problemLabel.stringValue = model.error ?? (touched ? model.problem ?? "" : "")
        problemLabel.isHidden = problemLabel.stringValue.isEmpty
        createButton.isEnabled = model.problem == nil && !model.isSaving
        createButton.showsSpinner = model.isSaving
    }

    private func create() {
        Task { @MainActor [weak self] in
            guard let self, let brand = await self.model.create() else { return }
            let app = self.model.app
            self.close()
            // Next: the kit, so the profile can be extracted.
            app.openBrandSettings(brand.id, tab: .kit)
        }
    }

    private func close() {
        onDone()
        if presentingViewController != nil { dismiss(nil) }
    }
}
