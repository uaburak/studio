import AppKit
import Foundation
import Observation
import StudioKit

// MARK: - NewBrandSheetController ("+ Yeni Marka…")

final class NewBrandSheetController: NSViewController, NSTextFieldDelegate {
    private unowned let app: AppModel
    private let onDone: () -> Void

    private let nameField = NSTextField()
    private let slugField = NSTextField()
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private var createBtn: PillButton!
    private var slugEditedManually = false
    private var isSaving = false

    init(app: AppModel, onDone: @escaping () -> Void) {
        self.app = app
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField.styledLabel("Yeni Marka Oluştur", font: NSFont.systemFont(ofSize: 15, weight: .semibold), color: Theme.textPrimary)

        nameField.placeholderString = "Örn. MTM Agro"
        nameField.bezelStyle = .roundedBezel
        nameField.delegate = self

        slugField.placeholderString = "mtm-agro"
        slugField.bezelStyle = .roundedBezel
        slugField.delegate = self

        statusLabel.font = Theme.smallFont
        statusLabel.textColor = .systemRed
        statusLabel.isHidden = true

        let cancelBtn = PillButton(title: "Vazgeç", kind: .secondary, height: 28) { [weak self] in
            self?.closeSheet()
        }
        createBtn = PillButton(title: "Oluştur", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.createBrand() }
        }
        createBtn.isEnabled = false

        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actions = NSStackView(views: [spacer, cancelBtn, createBtn])
        actions.orientation = .horizontal
        actions.alignment = .centerY
        actions.spacing = 8

        let stack = NSStackView(views: [
            title,
            NSTextField.styledLabel("Marka adı", font: Theme.captionFont, color: Theme.textSecondary),
            nameField,
            NSTextField.styledLabel("Kısa ad (URL slug)", font: Theme.captionFont, color: Theme.textSecondary),
            slugField,
            statusLabel,
            actions,
        ])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false

        nameField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        slugField.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        statusLabel.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        actions.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true

        root.addSubview(stack)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 400),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 18),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])

        self.view = root
    }

    override func cancelOperation(_ sender: Any?) {
        closeSheet()
    }

    func controlTextDidChange(_ obj: Notification) {
        guard let tf = obj.object as? NSTextField else { return }
        if tf === nameField && !slugEditedManually {
            slugField.stringValue = Brand.slugify(nameField.stringValue)
        } else if tf === slugField {
            slugEditedManually = !slugField.stringValue.isEmpty
        }
        createBtn.isEnabled = !nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !isSaving
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
        if commandSelector == #selector(NSResponder.insertNewline(_:)), createBtn.isEnabled {
            Task { await createBrand() }
            return true
        }
        return false
    }

    private func createBrand() async {
        let name = nameField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, !isSaving else { return }
        let slug = slugField.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        isSaving = true
        createBtn.showsSpinner = true
        createBtn.isEnabled = false
        defer {
            isSaving = false
            createBtn.showsSpinner = false
            createBtn.isEnabled = true
        }
        do {
            _ = try await app.createNewBrand(name: name, slug: slug.isEmpty ? nil : slug)
            closeSheet()
        } catch {
            statusLabel.stringValue = AppModel.describe(error)
            statusLabel.isHidden = false
        }
    }

    private func closeSheet() {
        onDone()
        dismiss(nil)
    }
}

// MARK: - BrandProfileModel & BrandProfileSheetController

@MainActor
@Observable
final class BrandProfileModel {
    unowned let app: AppModel
    let brandId: EntityID

    private(set) var profiles: [BrandProfile] = []
    var selectedVersion: Int?
    var designRulesDraft = ""
    var voiceDraft = ""
    var analysisNotes = ""
    private(set) var isLoading = false
    private(set) var isSaving = false
    private(set) var isApproving = false
    private(set) var isAnalyzing = false
    var statusMessage: String?
    var error: String?

    init(app: AppModel, brandId: EntityID) {
        self.app = app
        self.brandId = brandId
    }

    var selectedProfile: BrandProfile? {
        guard let selectedVersion else { return profiles.first }
        return profiles.first { $0.version == selectedVersion } ?? profiles.first
    }

    var colorSwatches: [(name: String, hex: String)] {
        guard let tokens = selectedProfile?.tokens else { return [] }
        return Self.extractHexColors(from: tokens)
    }

    static func extractHexColors(from tokens: JSONObject) -> [(name: String, hex: String)] {
        var found: [(String, String)] = []
        func walk(prefix: String, object: JSONObject) {
            for key in object.keys.sorted() {
                let label = prefix.isEmpty ? key : "\(prefix).\(key)"
                switch object[key] {
                case .string(let s) where s.hasPrefix("#") && (s.count == 7 || s.count == 4):
                    found.append((label, s))
                case .object(let child):
                    walk(prefix: label, object: child)
                default:
                    break
                }
            }
        }
        walk(prefix: "", object: tokens)
        return found
    }

    func load() async {
        isLoading = true
        defer { isLoading = false }
        do {
            let list = try await app.dataService.brandProfiles(brandId: brandId)
            profiles = list.sorted { $0.version > $1.version }
            if selectedVersion == nil || !profiles.contains(where: { $0.version == selectedVersion }) {
                selectedVersion = profiles.first(where: \.isCurrent)?.version ?? profiles.first?.version
            }
            syncDraftsFromSelection()
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func selectVersion(_ version: Int) {
        selectedVersion = version
        syncDraftsFromSelection()
        statusMessage = nil
    }

    func syncDraftsFromSelection() {
        designRulesDraft = selectedProfile?.designRules ?? ""
        voiceDraft = selectedProfile?.voice ?? ""
    }

    /// Saves into the current draft profile, or creates a new draft version when the selected version is approved (or none exists).
    func saveDraft() async {
        guard !isSaving else { return }
        isSaving = true
        defer { isSaving = false }
        do {
            let saved: BrandProfile
            if let current = selectedProfile, current.status == .draft {
                saved = try await app.dataService.updateBrandProfile(
                    brandId: brandId,
                    version: current.version,
                    BrandProfileUpdate(designRules: designRulesDraft, voice: voiceDraft)
                )
            } else {
                let baseTokens = selectedProfile?.tokens ?? [:]
                saved = try await app.dataService.createBrandProfile(
                    brandId: brandId,
                    BrandProfileCreate(tokens: baseTokens, designRules: designRulesDraft, voice: voiceDraft)
                )
            }
            selectedVersion = saved.version
            await load()
            statusMessage = "v\(saved.version) taslak olarak kaydedildi."
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func approveSelected() async {
        guard let target = selectedProfile, !isApproving else { return }
        isApproving = true
        defer { isApproving = false }
        do {
            // If there are unsaved edits on a draft, save them first before approving!
            if target.status == .draft, (designRulesDraft != target.designRules || voiceDraft != target.voice) {
                _ = try await app.dataService.updateBrandProfile(
                    brandId: brandId,
                    version: target.version,
                    BrandProfileUpdate(designRules: designRulesDraft, voice: voiceDraft)
                )
            }
            let approved = try await app.dataService.approveBrandProfile(brandId: brandId, version: target.version)
            selectedVersion = approved.version
            await load()
            statusMessage = "v\(approved.version) onaylandı ve aktif marka profili yapıldı."
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    func runAIAnalysis() async {
        guard !isAnalyzing else { return }
        isAnalyzing = true
        defer { isAnalyzing = false }
        do {
            let notes = analysisNotes.trimmingCharacters(in: .whitespacesAndNewlines)
            let job = try await app.dataService.analyzeBrand(brandId: brandId, notes: notes.isEmpty ? nil : notes)
            await load()
            if let newest = profiles.first {
                selectVersion(newest.version)
            }
            statusMessage = job.status == .succeeded
                ? "AI marka analizi tamamlandı; yeni taslak profil oluşturuldu."
                : "AI marka analizi kuyruğa alındı (\(job.id))."
            error = nil
        } catch {
            self.error = AppModel.describe(error)
        }
    }
}

final class BrandProfileSheetController: NSViewController, NSTextViewDelegate, NSTextFieldDelegate {
    let model: BrandProfileModel
    private let onDone: () -> Void

    private let versionPopup = NSPopUpButton()
    private let swatchesRow = FlowLayoutView()
    private let designTextView = NSTextView()
    private let voiceTextView = NSTextView()
    private let notesField = NSTextField()
    private let statusLabel = NSTextField(wrappingLabelWithString: "")
    private let errorBanner = InlineErrorBannerView()

    private var saveDraftBtn: PillButton!
    private var approveBtn: PillButton!
    private var analyzeBtn: PillButton!

    private var observation: ObservationToken?
    private var lastSyncedVersion: Int?

    init(app: AppModel, brandId: EntityID, startAnalysisImmediately: Bool = false, onDone: @escaping () -> Void) {
        self.model = BrandProfileModel(app: app, brandId: brandId)
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
        if startAnalysisImmediately {
            Task { @MainActor [weak self] in
                await self?.model.load()
                await self?.model.runAIAnalysis()
            }
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let brandName = model.app.brand(model.brandId)?.name ?? "Marka"
        let titleLabel = NSTextField.styledLabel("\(brandName) · Marka Profili", font: NSFont.systemFont(ofSize: 15, weight: .semibold), color: Theme.textPrimary)
        let topSpacer = NSView()
        topSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let doneBtn = PillButton(title: "Bitti", kind: .secondary, height: 26) { [weak self] in
            self?.closeSheet()
        }
        let headerRow = NSStackView(views: [titleLabel, topSpacer, doneBtn])
        headerRow.orientation = .horizontal
        headerRow.alignment = .centerY
        headerRow.translatesAutoresizingMaskIntoConstraints = false

        let topHairline = HairlineView()
        topHairline.translatesAutoresizingMaskIntoConstraints = false

        // Version row
        versionPopup.target = self
        versionPopup.action = #selector(versionPicked)

        analyzeBtn = PillButton(title: "AI ile Marka Analizi Başlat", kind: .outline, height: 26) { [weak self] in
            guard let self else { return }
            Task { await self.model.runAIAnalysis() }
        }
        let versionSpacer = NSView()
        versionSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let versionRow = NSStackView(views: [
            NSTextField.styledLabel("Sürüm:", font: Theme.captionFont, color: Theme.textSecondary),
            versionPopup,
            versionSpacer,
            analyzeBtn,
        ])
        versionRow.orientation = .horizontal
        versionRow.alignment = .centerY
        versionRow.spacing = 8

        notesField.placeholderString = "AI analizi için ek not (ör. kurumsal ton, koyu arka plan, hedef kitle)…"
        notesField.bezelStyle = .roundedBezel
        notesField.delegate = self

        swatchesRow.spacing = 10

        let designEditor = makeEditorBox(textView: designTextView, height: 135)
        let voiceEditor = makeEditorBox(textView: voiceTextView, height: 115)

        errorBanner.isHidden = true
        errorBanner.onDismiss = { [weak self] in self?.model.error = nil }

        statusLabel.font = Theme.smallFont
        statusLabel.textColor = Theme.textSecondary
        statusLabel.isHidden = true

        saveDraftBtn = PillButton(title: "Taslak Kaydet", kind: .secondary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.model.saveDraft() }
        }
        approveBtn = PillButton(title: "Bu Profili Onayla", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { await self.model.approveSelected() }
        }
        let bottomSpacer = NSView()
        bottomSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let bottomRow = NSStackView(views: [bottomSpacer, saveDraftBtn, approveBtn])
        bottomRow.orientation = .horizontal
        bottomRow.alignment = .centerY
        bottomRow.spacing = 8

        let bodyStack = NSStackView(views: [
            versionRow,
            notesField,
            NSTextField.styledLabel("Renk Tokenları (brand.json)", font: Theme.captionFont, color: Theme.textSecondary),
            swatchesRow,
            NSTextField.styledLabel("DESIGN.md · Tasarım kuralları", font: Theme.captionFont, color: Theme.textSecondary),
            designEditor,
            NSTextField.styledLabel("VOICE.md · Metin tonu", font: Theme.captionFont, color: Theme.textSecondary),
            voiceEditor,
            errorBanner,
            statusLabel,
            bottomRow,
        ])
        bodyStack.orientation = .vertical
        bodyStack.alignment = .leading
        bodyStack.spacing = 10
        bodyStack.translatesAutoresizingMaskIntoConstraints = false

        for full in [versionRow, notesField, swatchesRow, designEditor, voiceEditor, errorBanner, statusLabel, bottomRow] {
            full.widthAnchor.constraint(equalTo: bodyStack.widthAnchor).isActive = true
        }

        root.addSubview(headerRow)
        root.addSubview(topHairline)
        root.addSubview(bodyStack)

        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 620),
            headerRow.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            headerRow.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            headerRow.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),

            topHairline.leadingAnchor.constraint(equalTo: root.leadingAnchor),
            topHairline.trailingAnchor.constraint(equalTo: root.trailingAnchor),
            topHairline.topAnchor.constraint(equalTo: headerRow.bottomAnchor, constant: 12),

            bodyStack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            bodyStack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            bodyStack.topAnchor.constraint(equalTo: topHairline.bottomAnchor, constant: 16),
            bodyStack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])

        self.view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in
            self?.render()
        }
        Task { await model.load() }
    }

    override func cancelOperation(_ sender: Any?) {
        closeSheet()
    }

    private func makeEditorBox(textView: NSTextView, height: CGFloat) -> NSView {
        let box = ThemedView()
        box.borderColor = Theme.border
        box.borderWidth = 1
        box.cornerRadius = 12
        box.translatesAutoresizingMaskIntoConstraints = false
        box.heightAnchor.constraint(equalToConstant: height).isActive = true

        let scroll = NSScrollView()
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.hasVerticalScroller = true
        scroll.translatesAutoresizingMaskIntoConstraints = false

        textView.isRichText = false
        textView.drawsBackground = false
        textView.font = NSFont.monospacedSystemFont(ofSize: 12, weight: .regular)
        textView.textColor = Theme.textPrimary
        textView.delegate = self
        textView.isVerticallyResizable = true
        textView.autoresizingMask = [.width]
        textView.textContainer?.widthTracksTextView = true
        scroll.documentView = textView
        box.addSubview(scroll)

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 8),
            scroll.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -8),
            scroll.topAnchor.constraint(equalTo: box.topAnchor, constant: 8),
            scroll.bottomAnchor.constraint(equalTo: box.bottomAnchor, constant: -8),
        ])
        return box
    }

    func textDidChange(_ notification: Notification) {
        guard let tv = notification.object as? NSTextView else { return }
        if tv === designTextView {
            model.designRulesDraft = designTextView.string
        } else if tv === voiceTextView {
            model.voiceDraft = voiceTextView.string
        }
    }

    func controlTextDidChange(_ obj: Notification) {
        if (obj.object as? NSTextField) === notesField {
            model.analysisNotes = notesField.stringValue
        }
    }

    @objc private func versionPicked() {
        if let ver = versionPopup.selectedItem?.representedObject as? Int {
            lastSyncedVersion = nil
            model.selectVersion(ver)
        }
    }

    private func render() {
        // Version menu
        versionPopup.removeAllItems()
        if model.profiles.isEmpty {
            versionPopup.addItem(withTitle: "Henüz profil yok (Yeni taslak)")
            versionPopup.isEnabled = false
        } else {
            versionPopup.isEnabled = true
            for p in model.profiles {
                let currentSuffix = p.isCurrent ? " · Geçerli" : ""
                versionPopup.addItem(withTitle: "v\(p.version) · \(p.status.label)\(currentSuffix)")
                versionPopup.lastItem?.representedObject = p.version
                if p.version == model.selectedProfile?.version {
                    versionPopup.select(versionPopup.lastItem)
                }
            }
        }

        if model.selectedProfile?.version != lastSyncedVersion {
            lastSyncedVersion = model.selectedProfile?.version
            designTextView.string = model.designRulesDraft
            voiceTextView.string = model.voiceDraft
        }

        // Swatches
        let swatches = model.colorSwatches
        if swatches.isEmpty {
            swatchesRow.setItems([NSTextField.styledLabel("Henüz renk tokenı tanımlanmadı.", font: Theme.smallFont, color: Theme.textTertiary)])
        } else {
            swatchesRow.setItems(swatches.map { name, hex in
                let chip = ThemedView()
                chip.backgroundColor = Theme.fill
                chip.borderColor = Theme.border
                chip.borderWidth = 1
                chip.cornerRadius = 10
                let dot = StatusDotView(color: Self.parseHexColor(hex) ?? Theme.accent, size: 14)
                let lbl = NSTextField.styledLabel("\(name): \(hex)", font: NSFont.monospacedSystemFont(ofSize: 11, weight: .medium), color: Theme.textPrimary)
                let row = NSStackView(views: [dot, lbl])
                row.orientation = .horizontal
                row.alignment = .centerY
                row.spacing = 6
                row.translatesAutoresizingMaskIntoConstraints = false
                chip.addSubview(row)
                NSLayoutConstraint.activate([
                    chip.heightAnchor.constraint(equalToConstant: 26),
                    row.leadingAnchor.constraint(equalTo: chip.leadingAnchor, constant: 8),
                    row.trailingAnchor.constraint(equalTo: chip.trailingAnchor, constant: -8),
                    row.centerYAnchor.constraint(equalTo: chip.centerYAnchor),
                ])
                return chip
            })
        }

        if let err = model.error {
            errorBanner.message = err
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }

        if let msg = model.statusMessage {
            statusLabel.stringValue = msg
            statusLabel.isHidden = false
        } else {
            statusLabel.isHidden = true
        }

        let selected = model.selectedProfile
        saveDraftBtn.title = (selected?.status == .approved) ? "Yeni Taslak Olarak Kaydet" : "Taslak Kaydet"
        saveDraftBtn.showsSpinner = model.isSaving
        saveDraftBtn.isEnabled = !model.isSaving

        approveBtn.title = (selected?.isCurrent == true) ? "Geçerli Profil" : "Bu Profili Onayla"
        approveBtn.showsSpinner = model.isApproving
        approveBtn.isEnabled = selected != nil && selected?.isCurrent != true && !model.isApproving

        analyzeBtn.showsSpinner = model.isAnalyzing
        analyzeBtn.isEnabled = !model.isAnalyzing
    }

    private static func parseHexColor(_ hex: String) -> NSColor? {
        var clean = hex.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.hasPrefix("#") { clean.removeFirst() }
        if clean.count == 3 {
            clean = clean.map { "\($0)\($0)" }.joined()
        }
        guard clean.count == 6, let val = UInt32(clean, radix: 16) else { return nil }
        return NSColor(hex: val)
    }

    private func closeSheet() {
        onDone()
        dismiss(nil)
    }
}
