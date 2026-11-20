import StudioKit
import UIKit

// Two lists pushed from Marka Kiti, saved as you go like the rest of the kit: Kontroller (which
// generation checks run, strictness, automatic fixes, banned words) and Özel günler (sector tags,
// day categories, and the bayram dates every brand shares).

/// A pushed settings list: a column of plain sections parted by hairlines, with the save state
/// under the bar.
class BrandListPage: UIViewController {
    let model: BrandPageModel
    let scroll = UIScrollView()
    let column = UIStackView.v([], spacing: 0)
    let saveLabel = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    private var observation: IOSObservationToken?
    private var lastSignature: Int?

    init(model: BrandPageModel, title: String) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.keyboardDismissMode = .interactive
        scroll.topEdgeEffect.style = .soft
        view.addSubview(scroll)
        NSLayoutConstraint.activate([
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
        setContentScrollView(scroll, for: .top)
        let page = UIStackView.v([BrandUI.inset(saveLabel, top: 8, bottom: 4), column], spacing: 0)
        scroll.addSubview(page)
        NSLayoutConstraint.activate([
            page.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            page.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            page.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            page.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -40),
            page.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])
        observation = observeIOS { [weak self] in self?.refresh() }
    }

    private func refresh() {
        switch model.settingsSave {
        case .idle: saveLabel.text = nil
        case .saving: saveLabel.text = "Kaydediliyor…"
        case .saved: saveLabel.text = "Kaydedildi"
        case .failed(let message): saveLabel.text = message
        }
        saveLabel.textColor = if case .failed = model.settingsSave { .systemRed } else { IOSTheme.textSecondary }
        saveLabel.isHidden = saveLabel.text == nil
        // Rebuilt only when what the list shows changed (not on every save state).
        let signature = contentSignature()
        guard signature != lastSignature else { return }
        lastSignature = signature
        column.removeAllArranged()
        build()
    }

    func rebuild() {
        lastSignature = nil
        refresh()
    }

    /// Overridden: what the list shows, hashed.
    func contentSignature() -> Int { 0 }
    /// Overridden: fills `column`.
    func build() {}

    func addBlock(_ views: [UIView], spacing: CGFloat = 10, top: CGFloat = 18, bottom: CGFloat = 18) {
        column.addArrangedSubview(BrandUI.inset(UIStackView.v(views, spacing: spacing), top: top, bottom: bottom))
    }

    func addHairline(inset: CGFloat = 0) { column.addArrangedSubview(BrandUI.hairline(inset: inset)) }

    /// A row with a switch at the right.
    func switchRow(_ title: String, detail: String?, on: Bool, dimmed: Bool = false, change: @escaping (Bool) -> Void) -> UIView {
        let toggle = UISwitch()
        toggle.isOn = on
        toggle.onTintColor = IOSTheme.accent
        toggle.accessibilityLabel = "\(title) \(on ? "açık" : "kapalı")"
        toggle.addAction(UIAction { [weak toggle] _ in
            guard let toggle else { return }
            Haptics.selection()
            change(toggle.isOn)
        }, for: .valueChanged)
        let row = BrandRowView(title: title, detail: detail, trailing: toggle, chevron: false)
        row.titleLabel.textColor = dimmed ? IOSTheme.textSecondary : IOSTheme.textPrimary
        return row
    }
}

// MARK: - Kontroller

final class BrandChecksViewController: BrandListPage {
    private let bannedField = BrandFormPage.field(nil, placeholder: "ör. bedava, garantili, 1 numara")

    init(model: BrandPageModel) {
        super.init(model: model, title: "Kontroller")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        bannedField.returnKeyType = .done
        bannedField.addAction(UIAction { [weak self] _ in self?.addTyped() }, for: .editingDidEndOnExit)
    }

    override func contentSignature() -> Int {
        var hasher = Hasher()
        hasher.combine(model.checks?.put.disabledChecks)
        hasher.combine(model.checks?.put.bannedWords)
        hasher.combine(model.checks?.put.strictness)
        hasher.combine(model.checks?.put.autoFix)
        hasher.combine(model.checks == nil)
        return hasher.finalize()
    }

    override func build() {
        guard let settings = model.checks else {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            addBlock([spinner])
            return
        }
        addBlock([BrandUI.footnote("Her üretimden ve düzenlemeden sonra çalışan denetimler. Sonuçlar postun Kontroller listesinde görünür; başarısız kontrol varsa onaydan önce sorulur.")], top: 6)
        addHairline()

        let strictness = UISegmentedControl(items: [CheckStrictness.relaxed, .standard, .strict].map(\.label))
        strictness.selectedSegmentIndex = switch settings.strictness {
        case .relaxed: 0
        case .strict: 2
        default: 1
        }
        strictness.addAction(UIAction { [weak self, weak strictness] _ in
            guard let index = strictness?.selectedSegmentIndex else { return }
            let next = [CheckStrictness.relaxed, .standard, .strict][index]
            self?.model.changeChecks { $0.strictness = next }
        }, for: .valueChanged)
        addBlock([BrandUI.header("Sıkılık"), strictness, BrandUI.footnote(settings.strictness.detail)])
        addHairline()
        column.addArrangedSubview(switchRow(
            "Üretimden sonra otomatik düzelt",
            detail: "Taşan metni küçültür, güvenli alan dışındaki öğeyi içeri alır, kontrastı düşük metne marka rengi verir, sınırı aşan açıklamayı kısaltır. Düzeltme yeni sürüm olarak kaydedilir.",
            on: settings.autoFix) { [weak self] on in self?.model.changeChecks { $0.autoFix = on } })
        addHairline()

        for (category, checks) in CheckCatalog.byCategory {
            let ids = checks.map(\.id)
            let on = ids.filter { settings.isEnabled($0) }.count
            let state = on == ids.count ? "Hepsi açık" : (on == 0 ? "Kapalı" : "\(on)/\(ids.count) açık")
            let header = switchRow("\(category.step). \(category.label)", detail: state, on: on > 0) { [weak self] value in
                self?.model.changeChecks { $0.disabledChecks = CheckCatalog.toggle($0.disabledChecks, checks: ids, on: value) }
            }
            if let row = header as? BrandRowView { row.titleLabel.font = IOSTheme.font(17, .semibold, style: .headline) }
            column.addArrangedSubview(header)
            for check in checks {
                addHairline(inset: IOSTheme.gutter)
                let enabled = settings.isEnabled(check.id)
                let detail = "\(check.description)\n\(check.sourceLabel)\(check.fixable ? " · düzeltilebilir" : "")"
                column.addArrangedSubview(switchRow(check.label, detail: detail, on: enabled, dimmed: !enabled) { [weak self] value in
                    self?.model.changeChecks { $0.disabledChecks = CheckCatalog.toggle($0.disabledChecks, checks: [check.id], on: value) }
                })
            }
            addHairline()
        }

        let add = BrandUI.smallPill("Ekle", image: "plus") { [weak self] in self?.addTyped() }
        var banned: [UIView] = [
            BrandUI.header("Yasak kelimeler", detail: "Açıklamada ya da slayt metinlerinde geçerse kontrol başarısız olur. Ekleri de yakalar (“ücretsiz” → “ücretsizdir”). Virgülle birden çok kelime ekleyebilirsin."),
            UIStackView.h([bannedField, add], spacing: 8),
        ]
        if settings.bannedWords.isEmpty {
            banned.append(BrandUI.footnote("Liste boş.", color: IOSTheme.textTertiary))
        } else {
            banned.append(FlowView(settings.bannedWords.map { word in
                brandChip(word, removable: true) { [weak self] in
                    self?.model.changeChecks { $0.bannedWords.removeAll { $0 == word } }
                }
            }))
        }
        addBlock(banned)
    }

    private func addTyped() {
        let typed = bannedField.text ?? ""
        guard !typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        bannedField.text = nil
        model.changeChecks { $0.bannedWords = CheckCatalog.addBannedWords($0.bannedWords, typed: typed) }
    }
}

// MARK: - Özel günler

final class BrandSpecialDaysViewController: BrandListPage {
    private var bayram: [BayramYear] = []
    private var overrides: [ReligiousDayOverride] = []
    private var bayramError: String?
    private var bayramLoaded = false

    init(model: BrandPageModel) {
        super.init(model: model, title: "Özel günler")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await loadBayram() }
    }

    private var years: [Int] {
        let year = Calendar(identifier: .gregorian).component(.year, from: Date())
        return [year, year + 1, year + 2]
    }

    private func loadBayram() async {
        guard let service = model.service else { return }
        do {
            let loaded = try await service.specialDayOverrides()
            var days: [SpecialDay] = []
            for year in years {
                days += try await service.specialDays(from: "\(year)-01-01", to: "\(year)-12-31")
            }
            overrides = loaded.overrides
            bayram = years.map { BayramYear.from(year: $0, days: days, overrides: overrides) }
            bayramError = nil
        } catch {
            bayramError = IOSAppModel.describe(error)
        }
        bayramLoaded = true
        rebuild()
    }

    override func contentSignature() -> Int {
        var hasher = Hasher()
        hasher.combine(model.planning?.effectiveTags)
        hasher.combine(model.planning?.disabledCategories)
        hasher.combine(model.planning?.isSuggestion)
        hasher.combine(model.planning == nil)
        hasher.combine(bayram)
        hasher.combine(bayramError)
        return hasher.finalize()
    }

    override func build() {
        addBlock([BrandUI.footnote("Plan önerirken ve Takvim'de gösterilen Türkiye özel günleri. Sektör seçersen o sektörün günleri de eklenir; markaya uymayan türleri kapatabilirsin.")], top: 6)
        addHairline()
        if let planning = model.planning {
            let tags = Set(planning.effectiveTags)
            let disabled = Set(planning.disabledCategories)
            let chips = SectorTag.knownCases.map { tag in
                brandChip(tag.label, on: tags.contains(tag)) { [weak self] in
                    var next = tags
                    if next.contains(tag) { next.remove(tag) } else { next.insert(tag) }
                    self?.model.changePlanning(tags: next, disabled: disabled)
                }
            }
            addBlock([
                BrandUI.header("Sektör", detail: planning.isSuggestion
                    ? "Marka profilinden ve ürünlerden önerildi; değiştirebilirsin."
                    : "Seçtiğin sektörlerin günleri (ör. Tarım: Dünya Çiftçiler Günü, Dünya Toprak Günü) plana ve takvime eklenir."),
                FlowView(chips),
            ], spacing: 12)
            addHairline()
            for (index, category) in SpecialDayCategory.knownCases.enumerated() {
                let on = !disabled.contains(category)
                column.addArrangedSubview(switchRow(category.label, detail: category.examples, on: on, dimmed: !on) { [weak self] value in
                    var next = disabled
                    if value { next.remove(category) } else { next.insert(category) }
                    self?.model.changePlanning(tags: tags, disabled: next)
                })
                if index < SpecialDayCategory.knownCases.count - 1 { addHairline(inset: IOSTheme.gutter) }
            }
        } else {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            addBlock([spinner])
        }
        addHairline()

        addBlock([BrandUI.header("Bayram tarihleri (tüm markalar)", detail: "Diyanet takviminden ya da hesapla gelir. Diyanet'in açıkladığı ilk gün farklıysa düzelt; arife ve bayramın diğer günleri ona göre kayar.")], bottom: 4)
        if let bayramError {
            addBlock([BrandUI.footnote(bayramError, color: .systemRed)], top: 0)
            return
        }
        guard bayramLoaded else {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            addBlock([spinner], top: 0)
            return
        }
        var rows: [UIView] = []
        for row in bayram {
            for which in BayramYear.Which.allCases {
                let date = row.date(which)
                let corrected = row.corrected(which)
                let detail = corrected ? "Düzeltildi" : (row.approximate ? "Hesaplandı (±1 gün)" : "Diyanet")
                rows.append(BrandRowView(title: "\(row.year) \(which.label)", detail: detail, value: date.map(Self.dayText) ?? "—") { [weak self] in
                    self?.pickDate(which, row: row)
                })
            }
        }
        for (index, row) in rows.enumerated() {
            column.addArrangedSubview(row)
            if index < rows.count - 1 { addHairline(inset: IOSTheme.gutter) }
        }
    }

    private static let isoDay: DateFormatter = {
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "Europe/Istanbul")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()

    /// `2027-03-09` → "9 Mart 2027, Salı".
    static func dayText(_ iso: String) -> String {
        guard let date = isoDay.date(from: iso) else { return iso }
        let formatter = DateFormatter()
        formatter.locale = TurkishFormat.locale
        formatter.timeZone = TimeZone(identifier: "Europe/Istanbul")
        formatter.dateFormat = "d MMMM yyyy, EEEE"
        return formatter.string(from: date)
    }

    private func pickDate(_ which: BayramYear.Which, row: BayramYear) {
        let current = row.date(which).flatMap { Self.isoDay.date(from: $0) } ?? Date()
        let picker = BrandDayPickerViewController(title: "\(row.year) \(which.label)", date: current, year: row.year, corrected: row.corrected(which)) { [weak self] picked in
            guard let self else { return }
            let iso = picked.map { Self.isoDay.string(from: $0) }
            self.save(BayramYear.setting(which, of: row.year, to: iso, in: self.overrides))
        }
        presentSheet(picker, detents: [.medium(), .large()])
    }

    private func save(_ next: [ReligiousDayOverride]) {
        guard let service = model.service else { return }
        saveLabel.text = "Kaydediliyor…"
        saveLabel.isHidden = false
        Task {
            do {
                _ = try await service.saveSpecialDayOverrides(next)
                saveLabel.text = "Kaydedildi"
                await loadBayram()
            } catch {
                saveLabel.text = IOSAppModel.describe(error)
                saveLabel.textColor = .systemRed
            }
        }
    }
}

/// A bayram's first day: a calendar for that year; "Hesaplanana dön" drops the correction.
final class BrandDayPickerViewController: UIViewController {
    private let date: Date
    private let year: Int
    private let corrected: Bool
    private let onPick: (Date?) -> Void
    private let picker = UIDatePicker()

    init(title: String, date: Date, year: Int, corrected: Bool, onPick: @escaping (Date?) -> Void) {
        self.date = date
        self.year = year
        self.corrected = corrected
        self.onPick = onPick
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let save = UIBarButtonItem(title: "Kaydet", primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.onPick(self.picker.date)
            self.dismiss(animated: true)
        })
        save.style = .prominent
        navigationItem.rightBarButtonItem = save
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Istanbul") ?? .current
        picker.calendar = calendar
        picker.timeZone = calendar.timeZone
        picker.locale = TurkishFormat.locale
        picker.datePickerMode = .date
        picker.preferredDatePickerStyle = .inline
        picker.tintColor = IOSTheme.accent
        picker.minimumDate = calendar.date(from: DateComponents(year: year, month: 1, day: 1))
        picker.maximumDate = calendar.date(from: DateComponents(year: year, month: 12, day: 31))
        picker.date = date
        var views: [UIView] = [picker]
        if corrected {
            let reset = UIButton.studioPill(title: "Hesaplanana dön", kind: .secondary, image: "arrow.uturn.backward") { [weak self] in
                self?.onPick(nil)
                self?.dismiss(animated: true)
            }
            views.append(UIStackView.h([reset, UIView.spacer()], spacing: 0))
        }
        let stack = UIStackView.v(views, spacing: 12)
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
        ])
    }
}
