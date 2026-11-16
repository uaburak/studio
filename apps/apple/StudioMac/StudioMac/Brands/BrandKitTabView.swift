import AppKit
import StudioKit

/// "Marka kiti": sample posts (3–12), logos with light/dark variants, fonts with a
/// licence note, the palette (colour pickers) and notes. Saves itself; "Profili
/// çıkar" runs `brand.analyze` on it and shows the job's progress.
final class BrandKitTabView: NSView {
    private let model: BrandSettingsModel

    private let samplesList = BrandUI.vstack(spacing: 8)
    private let logosList = BrandUI.vstack(spacing: 8)
    private let fontsList = BrandUI.vstack(spacing: 8)
    private let paletteList = BrandUI.vstack(spacing: 8)
    private let uploadsList = BrandUI.vstack(spacing: 6)
    private let samplesCount = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textTertiary)
    private let notesBox: NSView
    private let notesView: NSTextView
    private let notesHandler: TextViewHandler
    private let kitErrorBanner = InlineErrorBannerView()

    // Footer
    private let saveStatus = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary)
    private let analysisLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textSecondary, wraps: true)
    private let progressBar = NSProgressIndicator()
    private var analyzeButton: PillButton!
    private var cancelButton: PillButton!

    private var signatures: [String: String] = [:]
    private var rowHandlers: [String: [AnyObject]] = [:]
    private var hexFields: [Int: NSTextField] = [:]
    private var colorWells: [Int: ClosureColorWell] = [:]
    private var observation: ObservationToken?

    init(model: BrandSettingsModel) {
        self.model = model
        (notesBox, notesView) = BrandUI.textEditor(height: 90)
        notesHandler = TextViewHandler { [weak model] text in model?.setNotes(text) }
        super.init(frame: .zero)
        notesView.delegate = notesHandler

        let (scroll, stack) = BrandUI.scrollingStack()
        let footer = makeFooter()
        addSubview(scroll)
        addSubview(footer)
        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: trailingAnchor),
            scroll.topAnchor.constraint(equalTo: topAnchor),
            scroll.bottomAnchor.constraint(equalTo: footer.topAnchor),
            footer.leadingAnchor.constraint(equalTo: leadingAnchor),
            footer.trailingAnchor.constraint(equalTo: trailingAnchor),
            footer.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])

        BrandUI.addFull(BrandUI.note("Örnek postlar, logolar, fontlar ve renkler markanın profilini çıkarmak için kullanılır. Değişiklikler kendiliğinden kaydedilir."), to: stack)

        let addSamples = PillButton(title: "Görsel ekle…", kind: .secondary, height: 26) { [weak self] in self?.pick(.sample) }
        BrandUI.addFull(BrandUI.sectionHeader("Örnek postlar", accessory: BrandUI.hstack([samplesCount, addSamples])), to: stack)
        BrandUI.addFull(BrandUI.note("Markanın daha önce paylaştığı 3–12 post görseli. Açıklama yazarsan ses tonu da ondan öğrenilir."), to: stack)
        BrandUI.addFull(samplesList, to: stack)

        let addLogo = PillButton(title: "Logo ekle…", kind: .secondary, height: 26) { [weak self] in self?.pick(.logo) }
        BrandUI.addFull(BrandUI.sectionHeader("Logolar", accessory: addLogo), to: stack)
        BrandUI.addFull(BrandUI.note("Açık ve koyu zemin sürümlerini ayrı ekle; her birinin hangi zemin için olduğunu seç."), to: stack)
        BrandUI.addFull(logosList, to: stack)

        let addFont = PillButton(title: "Font ekle…", kind: .secondary, height: 26) { [weak self] in self?.pick(.font) }
        BrandUI.addFull(BrandUI.sectionHeader("Fontlar", accessory: addFont), to: stack)
        BrandUI.addFull(BrandUI.note("Font ailesinin adını ve lisansını (nereden alındığı, neye izin verdiği) yaz."), to: stack)
        BrandUI.addFull(fontsList, to: stack)

        let addColor = PillButton(title: "Renk ekle", kind: .secondary, height: 26) { [weak model] in model?.addColor() }
        BrandUI.addFull(BrandUI.sectionHeader("Renk paleti", accessory: addColor), to: stack)
        BrandUI.addFull(BrandUI.note("Markanın kesin renkleri. Profil çıkarılırken bu renkler aynen kullanılır."), to: stack)
        BrandUI.addFull(paletteList, to: stack)

        BrandUI.addFull(uploadsList, to: stack)

        BrandUI.addFull(BrandUI.sectionHeader("Notlar"), to: stack)
        BrandUI.addFull(notesBox, to: stack)

        kitErrorBanner.isHidden = true
        kitErrorBanner.onDismiss = { [weak model] in model?.kitError = nil }
        BrandUI.addFull(kitErrorBanner, to: stack)

        observation = observe { [weak self] in self?.render() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func makeFooter() -> NSView {
        let footer = ThemedView()
        footer.backgroundColor = Theme.canvas
        footer.translatesAutoresizingMaskIntoConstraints = false
        let hairline = HairlineView()
        progressBar.style = .bar
        progressBar.controlSize = .small
        progressBar.minValue = 0
        progressBar.maxValue = 1
        progressBar.isIndeterminate = true
        progressBar.translatesAutoresizingMaskIntoConstraints = false
        progressBar.widthAnchor.constraint(equalToConstant: 140).isActive = true
        analysisLabel.maximumNumberOfLines = 2
        analysisLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        analyzeButton = PillButton(title: "Profili çıkar", kind: .primary, height: 30) { [weak self] in
            guard let self else { return }
            self.window?.makeFirstResponder(nil)
            Task { await self.model.startAnalysis() }
        }
        analyzeButton.toolTip = "Örnek postlar ve kitten taslak marka profili çıkarır (Claude)"
        cancelButton = PillButton(title: "İptal", kind: .secondary, height: 30) { [weak self] in
            guard let self else { return }
            Task { await self.model.cancelAnalysis() }
        }
        let left = BrandUI.vstack([saveStatus, BrandUI.hstack([progressBar, analysisLabel], spacing: 8)], spacing: 4)
        left.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let row = BrandUI.hstack([left, BrandUI.spacer(), cancelButton, analyzeButton], spacing: 10)
        footer.addSubview(hairline)
        footer.addSubview(row)
        NSLayoutConstraint.activate([
            hairline.leadingAnchor.constraint(equalTo: footer.leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: footer.trailingAnchor),
            hairline.topAnchor.constraint(equalTo: footer.topAnchor),
            row.leadingAnchor.constraint(equalTo: footer.leadingAnchor, constant: 24),
            row.trailingAnchor.constraint(equalTo: footer.trailingAnchor, constant: -20),
            row.topAnchor.constraint(equalTo: hairline.bottomAnchor, constant: 12),
            row.bottomAnchor.constraint(equalTo: footer.bottomAnchor, constant: -14),
        ])
        return footer
    }

    // MARK: Render

    private func render() {
        let kit = model.kit
        samplesCount.stringValue = "\(kit.samples.count)/\(BrandKit.maxSamples) · en az \(BrandKit.minSamples)"
        samplesCount.textColor = kit.samples.count < BrandKit.minSamples ? Theme.accent : Theme.textTertiary

        rebuild("samples", signature: kit.samples.map(\.assetId).joined(separator: ",") + "|\(model.isArchived)", list: samplesList) {
            if kit.samples.isEmpty { return [self.emptyRow("Henüz örnek post yok. En az 3 görsel ekle.")] }
            return kit.samples.map { self.sampleRow($0) }
        }
        rebuild("logos", signature: kit.logos.map { "\($0.assetId):\($0.background.rawValue)" }.joined(separator: ",") + "|\(model.isArchived)", list: logosList) {
            if kit.logos.isEmpty { return [self.emptyRow("Logo eklenmedi. İsteğe bağlı ama tasarımlarda logo kullanmak için gerekli.")] }
            return kit.logos.map { self.logoRow($0) }
        }
        rebuild("fonts", signature: kit.fonts.map { "\($0.assetId):\($0.role.rawValue)" }.joined(separator: ",") + "|\(model.isArchived)", list: fontsList) {
            if kit.fonts.isEmpty { return [self.emptyRow("Font eklenmedi. Eklenmezse profil sistem fontuyla başlar.")] }
            return kit.fonts.map { self.fontRow($0) }
        }
        rebuild("palette", signature: "\(kit.palette.count)|\(model.isArchived)", list: paletteList) {
            self.hexFields = [:]
            self.colorWells = [:]
            if kit.palette.isEmpty { return [self.emptyRow("Renk eklenmedi. Eklenmezse renkler örnek postlardan çıkarılır.")] }
            return kit.palette.indices.map { self.colorRow(at: $0) }
        }
        rebuild("uploads", signature: model.uploads.map { "\($0.id):\($0.error ?? "")" }.joined(separator: ","), list: uploadsList) {
            self.model.uploads.map { self.uploadRow($0) }
        }
        for upload in model.uploads where upload.error == nil {
            (uploadsList.arrangedSubviews.compactMap { $0 as? UploadRowView }.first { $0.uploadId == upload.id })?.progress = upload.progress
        }

        if notesView.window?.firstResponder !== notesView, notesView.string != kit.notes {
            notesView.string = kit.notes
        }
        notesView.isEditable = !model.isArchived

        if let error = model.kitError {
            kitErrorBanner.message = error
            kitErrorBanner.isHidden = false
        } else {
            kitErrorBanner.isHidden = true
        }

        switch model.kitSave {
        case .idle where model.isLoading: saveStatus.stringValue = "Yükleniyor…"
        case .idle: saveStatus.stringValue = kit.updatedAt == nil ? "Kit henüz kaydedilmedi" : "Kaydedildi"
        case .pending, .saving: saveStatus.stringValue = "Kaydediliyor…"
        case .saved: saveStatus.stringValue = "Kaydedildi"
        case .failed(let message): saveStatus.stringValue = "Kaydedilemedi: \(message)"
        }
        if case .failed = model.kitSave { saveStatus.textColor = .systemRed } else { saveStatus.textColor = Theme.textSecondary }

        renderAnalysis()
    }

    private func renderAnalysis() {
        progressBar.isHidden = true
        cancelButton.isHidden = true
        analysisLabel.textColor = Theme.textSecondary
        switch model.analysis {
        case .idle:
            analysisLabel.stringValue = model.analysisBlocker ?? "Hazır: profil çıkarmak birkaç dakika sürebilir."
        case .starting:
            progressBar.isHidden = false
            progressBar.isIndeterminate = true
            progressBar.startAnimation(nil)
            analysisLabel.stringValue = "Başlatılıyor…"
        case .running(_, let progress, let message):
            progressBar.isHidden = false
            cancelButton.isHidden = false
            if let progress {
                progressBar.isIndeterminate = false
                progressBar.doubleValue = progress
            } else {
                progressBar.isIndeterminate = true
                progressBar.startAnimation(nil)
            }
            analysisLabel.stringValue = message ?? "Çalışıyor…"
        case .succeeded(let version):
            analysisLabel.stringValue = version.map { "v\($0) taslağı hazır; Profil sekmesinde." } ?? "Taslak profil hazır; Profil sekmesinde."
        case .failed(let message):
            analysisLabel.stringValue = message
            analysisLabel.textColor = .systemRed
        }
        analyzeButton.isEnabled = model.analysisBlocker == nil && !model.isAnalyzing
        analyzeButton.showsSpinner = model.isAnalyzing
        analyzeButton.title = model.profiles.isEmpty ? "Profili çıkar" : "Profili yeniden çıkar"
        analyzeButton.toolTip = model.analysisBlocker ?? "Örnek postlar ve kitten yeni bir taslak profil çıkarır."
    }

    private func rebuild(_ key: String, signature: String, list: NSStackView, build: () -> [NSView]) {
        guard signatures[key] != signature else { return }
        signatures[key] = signature
        rowHandlers[key] = []
        currentKey = key
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        for row in build() { BrandUI.addFull(row, to: list) }
        currentKey = nil
    }

    private var currentKey: String?
    private func keep(_ object: AnyObject) {
        guard let currentKey else { return }
        rowHandlers[currentKey, default: []].append(object)
    }

    // MARK: Rows

    private func emptyRow(_ text: String) -> NSView {
        let (card, stack) = BrandUI.card(spacing: 4, padding: 12)
        BrandUI.addFull(BrandUI.note(text), to: stack)
        return card
    }

    private func thumbnail(_ assetId: EntityID, width: CGFloat, height: CGFloat, mode: AssetImageView.ContentMode, background: NSColor? = nil) -> NSView {
        let wrap = ThemedView()
        wrap.backgroundColor = background ?? Theme.fill
        wrap.cornerRadius = 8
        wrap.borderColor = Theme.hairline
        wrap.borderWidth = 1
        wrap.translatesAutoresizingMaskIntoConstraints = false
        let image = AssetImageView(store: model.app.images, assetId: assetId, contentMode: mode, cornerRadius: mode == .fill ? 8 : 0)
        image.translatesAutoresizingMaskIntoConstraints = false
        wrap.addSubview(image)
        let inset: CGFloat = mode == .fit ? 6 : 0
        NSLayoutConstraint.activate([
            wrap.widthAnchor.constraint(equalToConstant: width),
            wrap.heightAnchor.constraint(equalToConstant: height),
            image.leadingAnchor.constraint(equalTo: wrap.leadingAnchor, constant: inset),
            image.trailingAnchor.constraint(equalTo: wrap.trailingAnchor, constant: -inset),
            image.topAnchor.constraint(equalTo: wrap.topAnchor, constant: inset),
            image.bottomAnchor.constraint(equalTo: wrap.bottomAnchor, constant: -inset),
        ])
        return wrap
    }

    private func removeButton(_ help: String, action: @escaping () -> Void) -> GlyphButton {
        let button = GlyphButton(symbol: "xmark", size: 10, weight: .semibold, diameter: 24, action: action)
        button.toolTip = help
        button.setAccessibilityLabel(help)
        button.isEnabled = !model.isArchived
        return button
    }

    private func filename(_ assetId: EntityID) -> String {
        model.asset(assetId)?.originalFilename ?? "Dosya"
    }

    private func sampleRow(_ sample: BrandKitSample) -> NSView {
        let id = sample.assetId
        let thumb = thumbnail(id, width: 52, height: 65, mode: .fill)
        let name = NSTextField.styledLabel(filename(id), font: Theme.smallFont, color: Theme.textSecondary)
        let caption = BrandUI.field("Paylaşılan açıklama (isteğe bağlı)", text: sample.caption ?? "")
        let handler = FieldHandler(onChange: { [weak model] in model?.setSampleCaption(id, $0) })
        keep(handler)
        caption.delegate = handler
        caption.isEnabled = !model.isArchived
        let texts = BrandUI.vstack([name, caption], spacing: 4)
        caption.widthAnchor.constraint(equalTo: texts.widthAnchor).isActive = true
        let remove = removeButton("Örnek postu çıkar") { [weak model] in model?.removeSample(id) }
        return BrandUI.hstack([thumb, texts, remove], spacing: 12)
    }

    private func logoRow(_ logo: BrandKitLogo) -> NSView {
        let id = logo.assetId
        let background: NSColor = switch logo.background {
        case .dark: NSColor(white: 0.08, alpha: 1)
        case .light: .white
        default: Theme.fill
        }
        let thumb = thumbnail(id, width: 96, height: 52, mode: .fit, background: background)
        let name = NSTextField.styledLabel(filename(id), font: Theme.rowFont, color: Theme.textPrimary)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let popup = ClosurePopUp(
            items: [BrandKitLogoBackground.any, .light, .dark].map { ($0.label, $0 as Any) },
            selected: { ($0 as? BrandKitLogoBackground) == logo.background },
            onPick: { [weak model] value in
                if let bg = value as? BrandKitLogoBackground { model?.setLogoBackground(id, bg) }
            }
        )
        popup.isEnabled = !model.isArchived
        let remove = removeButton("Logoyu çıkar") { [weak model] in model?.removeLogo(id) }
        return BrandUI.hstack([thumb, name, BrandUI.spacer(), popup, remove], spacing: 12)
    }

    private func fontRow(_ font: BrandKitFont) -> NSView {
        let id = font.assetId
        let (card, stack) = BrandUI.card(spacing: 8, padding: 12)
        let file = NSTextField.styledLabel(filename(id), font: Theme.smallFont, color: Theme.textSecondary)
        let family = BrandUI.field("Font ailesi (ör. Archivo)", text: font.family)
        family.widthAnchor.constraint(equalToConstant: 200).isActive = true
        let familyHandler = FieldHandler(onChange: { [weak model] in model?.setFontFamily(id, $0) })
        family.delegate = familyHandler
        let role = ClosurePopUp(
            items: [BrandKitFontRole.any, .display, .text].map { ($0.label, $0 as Any) },
            selected: { ($0 as? BrandKitFontRole) == font.role },
            onPick: { [weak model] value in
                if let r = value as? BrandKitFontRole { model?.setFontRole(id, r) }
            }
        )
        let remove = removeButton("Fontu çıkar") { [weak model] in model?.removeFont(id) }
        let license = BrandUI.field("Lisans notu (ör. SIL OFL 1.1, Google Fonts)", text: font.licenseNote)
        let licenseHandler = FieldHandler(onChange: { [weak model] in model?.setFontLicense(id, $0) })
        license.delegate = licenseHandler
        keep(familyHandler)
        keep(licenseHandler)
        for control in [family, license] as [NSControl] + [role] { control.isEnabled = !model.isArchived }
        BrandUI.addFull(BrandUI.hstack([family, role, file, BrandUI.spacer(), remove], spacing: 10), to: stack)
        BrandUI.addFull(license, to: stack)
        return card
    }

    private func colorRow(at index: Int) -> NSView {
        let color = model.kit.palette[index]
        let hexField = BrandUI.field("#RRGGBB", text: color.hex)
        hexField.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        hexField.widthAnchor.constraint(equalToConstant: 92).isActive = true
        let well = ClosureColorWell(color: BrandUI.color(hex: color.hex) ?? Theme.accent) { [weak self, weak hexField] picked in
            let hex = BrandUI.hex(of: picked)
            hexField?.stringValue = hex
            self?.model.setColorHex(at: index, hex)
        }
        let hexHandler = FieldHandler(onChange: { [weak self, weak well] value in
            self?.model.setColorHex(at: index, value)
            if let parsed = BrandUI.color(hex: value) { well?.color = parsed }
        })
        hexField.delegate = hexHandler
        let name = BrandUI.field("ad (ör. accent)", text: color.name)
        name.widthAnchor.constraint(equalToConstant: 120).isActive = true
        let nameHandler = FieldHandler(onChange: { [weak model] in model?.setColorName(at: index, $0) }, onCommit: { [weak self, weak name] _ in
            guard let self, let name, self.model.kit.palette.indices.contains(index) else { return }
            name.stringValue = self.model.kit.palette[index].name
        })
        name.delegate = nameHandler
        let use = BrandUI.field("Kullanım (ör. tek vurgu, zemin)", text: color.use ?? "")
        let useHandler = FieldHandler(onChange: { [weak model] in model?.setColorUse(at: index, $0) })
        use.delegate = useHandler
        keep(hexHandler)
        keep(nameHandler)
        keep(useHandler)
        hexFields[index] = hexField
        colorWells[index] = well
        for control in [hexField, name, use, well] as [NSControl] { control.isEnabled = !model.isArchived }
        let remove = removeButton("Rengi çıkar") { [weak model] in model?.removeColor(at: index) }
        use.setContentHuggingPriority(.defaultLow, for: .horizontal)
        return BrandUI.hstack([well, name, hexField, use, remove], spacing: 8)
    }

    private func uploadRow(_ upload: BrandSettingsModel.Upload) -> NSView {
        let row = UploadRowView(upload: upload) { [weak model] in model?.dismissUploadError(upload.id) }
        return row
    }

    // MARK: Picking files

    private func pick(_ slot: BrandSettingsModel.Upload.Slot) {
        guard !model.isArchived else { return }
        let kitSlot: BrandKitFiles.Slot = switch slot {
        case .logo: .logo
        case .font: .font
        case .sample: .sample
        }
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = true
        panel.canChooseDirectories = false
        panel.allowedContentTypes = kitSlot.fileTypes
        panel.message = kitSlot.panelMessage
        panel.prompt = "Ekle"
        let handle: (NSApplication.ModalResponse) -> Void = { [weak self] response in
            guard response == .OK, let self else { return }
            let urls = panel.urls
            Task { await self.model.addFiles(urls, to: slot) }
        }
        if let window { panel.beginSheetModal(for: window, completionHandler: handle) } else { handle(panel.runModal()) }
    }
}

/// One upload in progress (or failed).
private final class UploadRowView: NSView {
    let uploadId: UUID
    private let bar = NSProgressIndicator()

    var progress: Double = 0 {
        didSet { bar.doubleValue = progress }
    }

    init(upload: BrandSettingsModel.Upload, onDismiss: @escaping () -> Void) {
        uploadId = upload.id
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let name = NSTextField.styledLabel(upload.filename, font: Theme.smallFont, color: Theme.textPrimary)
        var views: [NSView] = [name]
        if let error = upload.error {
            let label = NSTextField.styledLabel(error, font: Theme.smallFont, color: .systemRed, wraps: true)
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            let dismiss = GlyphButton(symbol: "xmark", size: 9, weight: .semibold, diameter: 22, action: onDismiss)
            dismiss.toolTip = "Kapat"
            views += [label, BrandUI.spacer(), dismiss]
        } else {
            bar.style = .bar
            bar.controlSize = .small
            bar.isIndeterminate = false
            bar.minValue = 0
            bar.maxValue = 1
            bar.doubleValue = upload.progress
            bar.translatesAutoresizingMaskIntoConstraints = false
            bar.widthAnchor.constraint(equalToConstant: 160).isActive = true
            views += [bar, NSTextField.styledLabel("Yükleniyor…", font: Theme.smallFont, color: Theme.textSecondary), BrandUI.spacer()]
        }
        let row = BrandUI.hstack(views, spacing: 10)
        addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.topAnchor.constraint(equalTo: topAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}
