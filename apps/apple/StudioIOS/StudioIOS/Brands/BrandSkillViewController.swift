import StudioKit
import UIKit

/// One skill in a sheet, like the Mac's skill editor: its name, one-line description and
/// Markdown text (Düzenle), the text as it reads (Önizleme) and its versions with "Geri yükle"
/// (Geçmiş); a note goes with the new version. Unsaved changes are not dropped by a swipe down.
final class BrandSkillViewController: UIViewController, UIAdaptivePresentationControllerDelegate {
    private enum Pane: Int { case edit, preview, history }

    private let model: BrandPageModel
    /// nil: a new skill (it gets an id once added).
    private var skillId: EntityID?
    private var skill: BrandSkill? { skillId.flatMap { id in model.skills.first { $0.id == id } } }

    private let panes = UISegmentedControl(items: ["Düzenle", "Önizleme", "Geçmiş"])
    private let editScroll = UIScrollView()
    private let previewScroll = UIScrollView()
    private let historyScroll = UIScrollView()
    private let nameField = BrandFormPage.field(nil, placeholder: "tek-gorsel-post", mono: true)
    private let descriptionField = BrandFormPage.field(nil, placeholder: "Ne zaman kullanılır (tek cümle)")
    private let metaLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    private let bodyView = UITextView()
    private let countLabel = UILabel.studio("", size: 12, color: IOSTheme.textTertiary, style: .caption1)
    private let noteField = BrandFormPage.field(nil, placeholder: "Değişiklik notu (isteğe bağlı)")
    private let problemLabel = UILabel.studio("", size: 13, color: .systemRed, lines: 0, style: .footnote)
    private let previewLabel = UILabel.studio("", size: 16, lines: 0, style: .body)
    private let historyStack = UIStackView.v([], spacing: 0)
    private var versions: [BrandSkillVersion] = []
    private var versionsError: String?
    private var lastVersion: Int?
    private var isSaving = false
    private var observation: IOSObservationToken?

    init(model: BrandPageModel, skillId: EntityID?) {
        self.model = model
        self.skillId = skillId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationController?.presentationController?.delegate = self
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Kapat", primaryAction: UIAction { [weak self] _ in self?.close() })
        panes.selectedSegmentIndex = Pane.edit.rawValue
        panes.addAction(UIAction { [weak self] _ in self?.showPane() }, for: .valueChanged)
        navigationItem.titleView = panes

        for scroll in [editScroll, previewScroll, historyScroll] {
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
        }
        nameField.autocapitalizationType = .none
        nameField.autocorrectionType = .no
        bodyView.translatesAutoresizingMaskIntoConstraints = false
        bodyView.isScrollEnabled = false
        bodyView.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        bodyView.textColor = IOSTheme.textPrimary
        bodyView.backgroundColor = IOSTheme.fill
        bodyView.layer.cornerRadius = 12
        bodyView.layer.cornerCurve = .continuous
        bodyView.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        bodyView.autocorrectionType = .no
        bodyView.smartQuotesType = .no
        bodyView.smartDashesType = .no
        bodyView.heightAnchor.constraint(greaterThanOrEqualToConstant: 320).isActive = true
        countLabel.font = IOSTheme.monoDigits(12)
        problemLabel.isHidden = true
        for field in [nameField, descriptionField, noteField] {
            field.addAction(UIAction { [weak self] _ in self?.changed() }, for: .editingChanged)
        }
        NotificationCenter.default.addObserver(forName: UITextView.textDidChangeNotification, object: bodyView, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.changed() }
        }
        let edit = UIStackView.v([
            BrandFormPage.labeled("Ad", nameField, hint: "Küçük harf, rakam ve tire."),
            BrandFormPage.labeled("Açıklama", descriptionField),
            metaLabel,
            BrandFormPage.labeled("Skill metni (Markdown)", bodyView),
            countLabel,
            noteField,
            problemLabel,
        ], spacing: 14)
        place(edit, in: editScroll)
        place(previewLabel, in: previewScroll)
        place(historyStack, in: historyScroll, sides: 0)

        fill(from: skill)
        observation = observeIOS { [weak self] in self?.modelChanged() }
        showPane()
        if skill == nil { nameField.becomeFirstResponder() }
    }

    private func place(_ content: UIView, in scroll: UIScrollView, sides: CGFloat = IOSTheme.gutter) {
        content.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(content)
        NSLayoutConstraint.activate([
            content.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 16),
            content.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: sides),
            content.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -sides),
            content.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            content.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * sides),
        ])
    }

    /// The form from a skill (or a new one's starting text with a free name).
    private func fill(from skill: BrandSkill?) {
        nameField.text = skill?.name ?? BrandSkillRules.uniqueName("yeni-skill", taken: model.skills.map(\.name))
        descriptionField.text = skill?.description ?? ""
        bodyView.text = skill?.body ?? BrandSkillRules.newBody
        noteField.text = ""
        lastVersion = skill?.version
        changed()
    }

    /// A newer version from elsewhere (restore, the Mac) replaces an untouched form.
    private func modelChanged() {
        guard let skill else {
            if skillId != nil { dismiss(animated: true) }
            renderMeta()
            return
        }
        if skill.version != lastVersion, !isDirty {
            fill(from: skill)
            Task { await loadVersions() }
        }
        renderMeta()
    }

    private var isDirty: Bool {
        guard let skill else { return true }
        return (nameField.text ?? "").trimmingCharacters(in: .whitespaces) != skill.name
            || (descriptionField.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines) != skill.description
            || bodyView.text != skill.body
    }

    private var problem: String? {
        BrandSkillRules.problem(
            name: nameField.text ?? "", description: descriptionField.text ?? "", body: bodyView.text ?? "",
            otherNames: model.skills.filter { $0.id != skillId }.map(\.name))
    }

    private func changed() {
        countLabel.text = "\((bodyView.text ?? "").count.formatted(.number.locale(TurkishFormat.locale))) / 40.000"
        let problem = problem
        problemLabel.text = problem
        problemLabel.isHidden = problem == nil || !isDirty
        navigationController?.isModalInPresentation = isDirty
        renderBar()
    }

    private func renderMeta() {
        title = skill?.name ?? "Yeni skill"
        if let skill {
            var parts = ["v\(skill.version)"]
            if skill.origin != .manual { parts.append(skill.origin.label) }
            parts.append(skill.enabled ? "Açık: sohbete ve üretime eklenir" : "Kapalı: ajan görmez")
            metaLabel.text = parts.joined(separator: " · ")
        } else {
            metaLabel.text = "Kaydedilmedi"
        }
        panes.setEnabled(skill != nil, forSegmentAt: Pane.history.rawValue)
        renderBar()
    }

    private func renderBar() {
        if isSaving {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            navigationItem.rightBarButtonItems = [UIBarButtonItem(customView: spinner)]
            return
        }
        let save = UIBarButtonItem(title: skill == nil ? "Ekle" : "Kaydet", primaryAction: UIAction { [weak self] _ in self?.save() })
        save.style = .prominent
        save.isEnabled = isDirty && problem == nil
        var items = [save]
        if let skill {
            let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [
                UIAction(title: skill.enabled ? "Kapat" : "Aç", subtitle: skill.enabled ? "Ajan bu skill'i görmez" : "Sohbete ve üretime eklenir", image: UIImage(systemName: skill.enabled ? "pause.circle" : "play.circle")) { [weak self] _ in
                    guard let self else { return }
                    Task { if let problem = await self.model.setSkill(skill, enabled: !skill.enabled) { self.presentError(problem) } }
                },
                UIAction(title: "Sil…", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in self?.delete(skill) },
            ]))
            more.accessibilityLabel = "Skill seçenekleri"
            items.append(more)
        }
        navigationItem.rightBarButtonItems = items
    }

    private func showPane() {
        let pane = Pane(rawValue: panes.selectedSegmentIndex) ?? .edit
        editScroll.isHidden = pane != .edit
        previewScroll.isHidden = pane != .preview
        historyScroll.isHidden = pane != .history
        switch pane {
        case .edit: break
        case .preview:
            view.endEditing(true)
            let body = bodyView.text ?? ""
            previewLabel.attributedText = body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? NSAttributedString(string: "Boş.", attributes: [.foregroundColor: IOSTheme.textTertiary, .font: IOSTheme.font(16)])
                : ChatText.assistant(body, aliases: [])
        case .history:
            view.endEditing(true)
            renderHistory()
            Task { await loadVersions() }
        }
    }

    // MARK: History

    private func loadVersions() async {
        guard let skillId, let service = model.service else { return }
        do {
            versions = try await service.brandSkillVersions(brandId: model.brandId, skillId: skillId)
            versionsError = nil
        } catch {
            versionsError = IOSAppModel.describe(error)
        }
        renderHistory()
    }

    private func renderHistory() {
        historyStack.removeAllArranged()
        if isDirty, skill != nil {
            historyStack.addArrangedSubview(BrandUI.inset(BrandUI.footnote("Kaydedilmemiş değişikliklerin var; geri yükleme onları bırakır.", color: IOSTheme.accent), bottom: 10))
        }
        if let versionsError {
            historyStack.addArrangedSubview(BrandUI.inset(BrandUI.footnote(versionsError, color: .systemRed)))
            return
        }
        if versions.isEmpty {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            historyStack.addArrangedSubview(BrandUI.inset(spinner, top: 12))
            return
        }
        for (index, version) in versions.enumerated() {
            let current = version.version == skill?.version
            var detail = [AssistantStatus.relative(version.createdAt), version.origin.label]
            if !version.note.isEmpty { detail.append(version.note) }
            if version.name != skill?.name { detail.append(version.name) }
            var actions: [UIMenuElement] = [UIAction(title: "Oku", image: UIImage(systemName: "doc.text")) { [weak self] _ in
                self?.presentSheet(TextReaderViewController(title: "v\(version.version)", text: version.body), detents: [.large()])
            }]
            if !current {
                actions.append(UIAction(title: "Geri yükle", image: UIImage(systemName: "arrow.uturn.backward")) { [weak self] _ in self?.restore(version) })
            }
            let row = BrandRowView(title: "v\(version.version)\(current ? " · şu anki" : "")", detail: detail.joined(separator: " · "), menu: UIMenu(children: actions))
            historyStack.addArrangedSubview(row)
            if index < versions.count - 1 { historyStack.addArrangedSubview(BrandUI.hairline(inset: IOSTheme.gutter)) }
        }
    }

    private func restore(_ version: BrandSkillVersion) {
        guard let skillId, let service = model.service else { return }
        Task {
            do {
                let restored = try await service.restoreBrandSkillVersion(brandId: model.brandId, skillId: skillId, version: version.version)
                model.put(restored)
                fill(from: restored)
                await loadVersions()
                panes.selectedSegmentIndex = Pane.edit.rawValue
                showPane()
                Haptics.success()
                Toast.show("v\(version.version) geri yüklendi (v\(restored.version))", in: view)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
        }
    }

    // MARK: Saving

    private func save() {
        guard !isSaving else { return }
        isSaving = true
        renderBar()
        let existing = skill
        Task {
            let result = await model.saveSkill(existing, name: nameField.text ?? "", description: descriptionField.text ?? "", body: bodyView.text ?? "", note: noteField.text ?? "")
            isSaving = false
            switch result {
            case .success(let saved):
                skillId = saved.id
                fill(from: saved)
                renderMeta()
                Haptics.success()
                Toast.show(existing == nil ? "\(saved.name) eklendi" : "\(saved.name) v\(saved.version) kaydedildi", in: view)
                if panes.selectedSegmentIndex == Pane.history.rawValue { await loadVersions() }
            case .failure(let problem):
                renderBar()
                presentError(problem.message)
            }
        }
    }

    private func delete(_ skill: BrandSkill) {
        confirm("\(skill.name) silinsin mi?", message: "Skill ve bütün sürümleri kalıcı olarak silinir. Yalnızca kullanılmasın istiyorsan kapatman yeterli.", action: "Sil") { [weak self] in
            guard let self else { return }
            Task {
                if let problem = await self.model.deleteSkill(skill) {
                    self.presentError(problem)
                } else {
                    Haptics.success()
                    self.dismiss(animated: true)
                }
            }
        }
    }

    private func close() {
        guard isDirty, skill != nil || !(bodyView.text ?? "").isEmpty else { return dismiss(animated: true) }
        confirm("Kaydedilmemiş değişiklikler", message: "Bu skill'deki değişiklikler kaydedilmedi. Bırakıp çıkılsın mı?", action: "Değişiklikleri bırak") { [weak self] in
            self?.dismiss(animated: true)
        }
    }

    func presentationControllerDidAttemptToDismiss(_ presentationController: UIPresentationController) {
        close()
    }
}
