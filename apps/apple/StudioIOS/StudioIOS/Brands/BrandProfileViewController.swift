import StudioKit
import UIKit

/// The sections of a brand's page, as on the Mac's brand page.
enum BrandTab: Int, CaseIterable {
    case general, kit, profile, accounts, products, templates

    var title: String {
        switch self {
        case .general: "Genel"
        case .kit: "Marka Kiti"
        case .profile: "Profil"
        case .accounts: "Hesaplar"
        case .products: "Ürünler"
        case .templates: "Şablonlar"
        }
    }
}

/// One brand, laid out like the Profil screen: the brand's round mark, name and counts, a short
/// "bio" (short name, language, profile state, the voice's opening, the palette) and two wide
/// pills; under it a sideways-scrolling tab strip with an underline for Genel, Marka Kiti,
/// Profil, Hesaplar, Ürünler and Şablonlar. Everything the Mac's brand page does is here:
/// editing goes into sheets (a skill's editor too), the longer lists (checks, special days) and a
/// product's page are pushed.
final class BrandProfileViewController: UIViewController {
    private unowned let app: IOSAppModel
    let brandId: EntityID
    let model: BrandPageModel
    private(set) var currentTab: BrandTab

    private let scroll = UIScrollView()
    private let header = BrandPageHeader()
    private let tabs = BrandTabStrip()
    let body = UIStackView.v([], spacing: 0)
    private var observation: IOSObservationToken?
    private var lastSignature: Int?
    /// Tiles of the Ürünler tab the product page zooms out of (by product id).
    var productTiles: [EntityID: UIView] = [:]
    /// The profile version picked in Profil (nil: the current one).
    var profileVersion: Int?

    init(app: IOSAppModel, brandId: EntityID, tab: BrandTab = .general) {
        self.app = app
        self.brandId = brandId
        self.currentTab = tab
        self.model = BrandPageModel(app: app, brandId: brandId)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.pageMenu() ?? [])
        }]))
        more.accessibilityLabel = "Marka seçenekleri"
        navigationItem.rightBarButtonItem = more

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.topEdgeEffect.style = .soft
        scroll.contentInset.bottom = 40
        view.addSubview(scroll)
        scroll.pin(to: view)
        setContentScrollView(scroll, for: .top)

        let column = UIStackView.v([header, tabs, body], spacing: 0)
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            column.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            column.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])

        header.images = app.images
        header.onSelect = { [weak self] in self?.selectBrand() }
        header.onChat = { [weak self] in self?.openChat() }
        header.onCount = { [weak self] tab in self?.show(tab) }
        tabs.onSelect = { [weak self] tab in self?.show(tab) }

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task {
                await self?.model.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        scroll.refreshControl = refresh

        observation = observeIOS { [weak self] in self?.render() }
        Task { await model.load() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        model.flushKit()
    }

    func show(_ next: BrandTab) {
        guard next != currentTab else { return }
        currentTab = next
        Haptics.selection()
        render()
    }

    /// Renders even when the model did not change (a picked profile version).
    func renderAgain() {
        lastSignature = nil
        render()
    }

    // MARK: Render

    private func signature() -> Int {
        var hasher = Hasher()
        hasher.combine(currentTab)
        hasher.combine(model.brand)
        hasher.combine(model.kit)
        hasher.combine(model.kitError)
        hasher.combine(model.profiles)
        hasher.combine(model.skills)
        hasher.combine(model.skillsError)
        hasher.combine(model.templates)
        hasher.combine(model.templatesError)
        hasher.combine(model.checks)
        hasher.combine(model.planning)
        hasher.combine(model.products.products)
        hasher.combine(model.products.hasLoaded)
        hasher.combine(model.fontFaces.keys.sorted())
        hasher.combine(model.fontAssets.keys.sorted())
        hasher.combine(model.kitSave)
        hasher.combine(model.settingsSave)
        hasher.combine(model.uploads)
        hasher.combine(model.error)
        hasher.combine(model.hasLoaded)
        hasher.combine(app.currentBrandId == brandId)
        hasher.combine(app.accounts(of: brandId))
        hasher.combine(app.isOnline)
        for job in app.jobBoard.jobs where job.brandId == brandId && !job.status.isTerminal && (job.type == .brandAnalyze || job.type == .brandSkillDraft) {
            hasher.combine(job.id)
            hasher.combine(job.progressMessage)
            hasher.combine(job.progress)
        }
        return hasher.finalize()
    }

    private func render() {
        model.jobsChanged(app.jobBoard.jobs)
        let signature = signature()
        guard signature != lastSignature else { return }
        lastSignature = signature
        title = model.brand?.name ?? "Marka"
        guard let brand = model.brand, let overview = model.overview else {
            header.isHidden = true
            tabs.isHidden = true
            body.removeAllArranged()
            if model.hasLoaded {
                body.addArrangedSubview(BrandUI.inset(BrandUI.footnote("Marka bulunamadı."), top: 24))
            } else {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.startAnimating()
                body.addArrangedSubview(BrandUI.inset(spinner, top: 40))
            }
            return
        }
        header.isHidden = false
        tabs.isHidden = false
        header.configure(
            brand: brand, overview: overview, isCurrent: model.isCurrent,
            counts: [(.products, model.products.products.count, "ürün"), (.templates, model.templates.count, "şablon"), (.kit, model.skills.count, "skill")],
            status: statusLine(), loading: model.isLoading && !model.hasLoaded)
        tabs.select(currentTab)
        productTiles = [:]
        body.removeAllArranged()
        switch currentTab {
        case .general: buildGeneral(brand, overview)
        case .kit: buildKit(brand)
        case .profile: buildProfile(brand)
        case .accounts: buildAccounts(overview)
        case .products: buildProducts()
        case .templates: buildTemplates()
        }
    }

    /// What is going on with the brand right now (the analysis, a draft to approve).
    private func statusLine() -> (text: String, attention: Bool)? {
        if let job = model.runningJob(.brandAnalyze) {
            let percent = job.progress.map { " · %\(Int($0 * 100))" } ?? ""
            return ((job.progressMessage ?? "Marka analiz ediliyor…") + percent, true)
        }
        if let draft = model.waitingDraft { return ("Profil taslağı v\(draft.version) onayını bekliyor", true) }
        if model.isArchived { return ("Arşivde: listelerde görünmez", false) }
        return nil
    }

    // MARK: Actions

    private func pageMenu() -> [UIMenuElement] {
        guard let brand = model.brand else { return [] }
        var primary: [UIMenuElement] = []
        if !model.isCurrent && !model.isArchived {
            primary.append(UIAction(title: "Bu markayı seç", image: UIImage(systemName: "checkmark.circle")) { [weak self] _ in self?.selectBrand() })
        }
        primary.append(UIAction(title: "Sohbette konuş", image: UIImage(systemName: "bubble.left.and.text.bubble.right")) { [weak self] _ in self?.openChat() })
        let running = model.runningJob(.brandAnalyze) != nil
        primary.append(UIAction(title: "AI ile analiz et", subtitle: running ? "Sürüyor" : "Örnek postlardan profil taslağı", image: UIImage(systemName: "sparkles"), attributes: running ? .disabled : []) { [weak self] _ in self?.analyze() })
        let edit: [UIMenuElement] = [
            UIAction(title: "Ad, kısa ad ve dil…", image: UIImage(systemName: "pencil")) { [weak self] _ in self?.editBrand() },
        ]
        let archive = UIAction(
            title: brand.status == .archived ? "Arşivden çıkar" : "Arşivle…",
            image: UIImage(systemName: brand.status == .archived ? "tray.and.arrow.up" : "archivebox"),
            attributes: brand.status == .archived ? [] : .destructive) { [weak self] _ in self?.toggleArchive() }
        return [
            UIMenu(options: .displayInline, children: primary),
            UIMenu(options: .displayInline, children: edit),
            UIMenu(options: .displayInline, children: [archive]),
        ]
    }

    func selectBrand() {
        guard !model.isArchived else { return presentError("Arşivdeki marka seçilemez; önce arşivden çıkar.") }
        app.selectBrand(brandId)
        Haptics.success()
        Toast.show("\(model.brand?.name ?? "Marka") seçildi", in: view)
    }

    private func openChat() {
        if !model.isArchived { app.selectBrand(brandId) }
        app.open(.newConversation)
    }

    func analyze() {
        Task {
            if let problem = await model.analyze() {
                presentError(problem, title: "Analiz başlamadı")
            } else {
                Haptics.success()
                Toast.show("Marka analizi başladı; bitince taslak profil onaya düşer.", in: view)
            }
        }
    }

    func editBrand() {
        guard let brand = model.brand else { return }
        let form = BrandFormViewController(mode: .edit(brand)) { [weak self] name, slug, language in
            guard let self else { return "Sayfa kapandı." }
            if let problem = BrandOverview.slugProblem(slug) { return problem }
            if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Marka adı boş olamaz." }
            let input = BrandUpdate(
                name: name == brand.name ? nil : name, slug: slug == brand.slug ? nil : slug,
                defaultLanguage: language == brand.defaultLanguage ? nil : language)
            guard input != BrandUpdate() else { return nil }
            if let problem = await self.model.updateBrand(input) { return problem }
            Toast.show("Marka kaydedildi", in: self.view)
            return nil
        }
        presentSheet(form, detents: [.large()])
    }

    func toggleArchive() {
        guard let brand = model.brand else { return }
        let run = { [weak self] in
            guard let self else { return }
            Task {
                let archiving = brand.status != .archived
                if let problem = await self.model.updateBrand(BrandUpdate(status: archiving ? .archived : .active)) {
                    self.presentError(problem)
                } else {
                    Haptics.success()
                    Toast.show(archiving ? "Marka arşivlendi" : "Marka arşivden çıkarıldı", in: self.view)
                }
            }
        }
        if brand.status == .archived { return run() }
        confirm("\(brand.name) arşivlensin mi?", message: "Marka silinmez; listelerden kalkar, sonra geri getirilebilir.", action: "Arşivle", onConfirm: run)
    }
}

// MARK: - Header

/// The brand at the top, like the Profil screen's header: the mark in a ring (orange while a
/// draft waits or the analysis runs), the name and counts, a bio and two wide pills.
final class BrandPageHeader: UIView {
    var onSelect: (() -> Void)?
    var onChat: (() -> Void)?
    var onCount: ((BrandTab) -> Void)?
    weak var images: IOSImageStore? {
        didSet { if images !== oldValue { rebuildMark() } }
    }

    private let ring = UIView()
    private var mark: BrandMarkView?
    private let nameLabel = UILabel.studio("", size: 17, weight: .semibold, lines: 2, style: .headline)
    private let selectedMark = UIImageView(image: UIImage(systemName: "checkmark.seal.fill"))
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let countStack = UIStackView()
    private let subtitleLabel = UILabel.studio("", size: 14, weight: .semibold, lines: 0, style: .subheadline)
    private let statusLabel = UILabel.studio("", size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline)
    private let bioLabel = UILabel.studio("", size: 14, lines: 3, style: .subheadline)
    private let swatchRow = UIStackView.h([], spacing: 6)
    private let selectButton = UIButton.studioPill(title: "Bu markayı seç", kind: .ink) {}
    private let chatButton = UIButton.studioPill(title: "Sohbette konuş", kind: .secondary) {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        ring.translatesAutoresizingMaskIntoConstraints = false
        ring.layer.cornerRadius = 43
        ring.layer.borderWidth = 2.5
        ring.layer.borderColor = IOSTheme.border.cgColor
        NSLayoutConstraint.activate([ring.widthAnchor.constraint(equalToConstant: 86), ring.heightAnchor.constraint(equalToConstant: 86)])
        rebuildMark()

        selectedMark.tintColor = IOSTheme.accent
        selectedMark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        selectedMark.setContentHuggingPriority(.required, for: .horizontal)
        selectedMark.accessibilityLabel = "Seçili marka"
        selectedMark.isAccessibilityElement = true
        spinner.hidesWhenStopped = true
        countStack.axis = .horizontal
        countStack.distribution = .fillEqually
        countStack.spacing = 8
        let nameRow = UIStackView.h([nameLabel, selectedMark, spinner, UIView.spacer()], spacing: 6)
        let right = UIStackView.v([nameRow, countStack], spacing: 6)
        let top = UIStackView.h([ring, right], spacing: 18, alignment: .center)

        selectButton.addAction(UIAction { [weak self] _ in self?.onSelect?() }, for: .touchUpInside)
        chatButton.addAction(UIAction { [weak self] _ in self?.onChat?() }, for: .touchUpInside)
        let buttons = UIStackView.h([selectButton, chatButton], spacing: 8)
        buttons.distribution = .fillEqually

        let bio = UIStackView.v([subtitleLabel, statusLabel, bioLabel, swatchRow], spacing: 4, alignment: .leading)
        bio.setCustomSpacing(8, after: bioLabel)
        let stack = UIStackView.v([top, bio, buttons], spacing: 12)
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 8, left: IOSTheme.gutter, bottom: 14, right: IOSTheme.gutter))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.ring.layer.borderColor = (self.attention ? IOSTheme.accent : IOSTheme.border).cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var attention = false

    private func rebuildMark() {
        mark?.removeFromSuperview()
        let view = BrandMarkView(side: 76, images: images)
        ring.addSubview(view)
        NSLayoutConstraint.activate([view.centerXAnchor.constraint(equalTo: ring.centerXAnchor), view.centerYAnchor.constraint(equalTo: ring.centerYAnchor)])
        mark = view
    }

    func configure(brand: Brand, overview: BrandOverview, isCurrent: Bool, counts: [(BrandTab, Int, String)], status: (text: String, attention: Bool)?, loading: Bool) {
        mark?.configure(overview)
        nameLabel.text = brand.name
        selectedMark.isHidden = !isCurrent
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        attention = status?.attention == true
        ring.layer.borderColor = (attention ? IOSTheme.accent : IOSTheme.border).cgColor

        countStack.removeAllArranged()
        for (tab, count, title) in counts {
            let number = UILabel.studio("\(count)", size: 17, weight: .semibold, style: .headline)
            let label = UILabel.studio(title, size: 14, color: IOSTheme.textSecondary, style: .subheadline)
            let column = UIStackView.v([number, label], spacing: 0)
            column.isUserInteractionEnabled = false
            let control = UIControl()
            control.translatesAutoresizingMaskIntoConstraints = false
            control.addSubview(column)
            column.pin(to: control)
            control.addAction(UIAction { [weak self] _ in self?.onCount?(tab) }, for: .touchUpInside)
            control.isAccessibilityElement = true
            control.accessibilityLabel = "\(count) \(title)"
            control.accessibilityTraits = .button
            countStack.addArrangedSubview(control)
        }

        subtitleLabel.text = "\(overview.subtitle) · \(overview.profileLine)"
        statusLabel.text = status?.text
        statusLabel.textColor = status?.attention == true ? IOSTheme.accent : IOSTheme.textSecondary
        statusLabel.isHidden = status == nil
        bioLabel.text = overview.voice
        bioLabel.isHidden = overview.voice == nil
        swatchRow.removeAllArranged()
        for swatch in overview.swatches {
            let dot = UIView()
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.backgroundColor = UIColor(hexString: swatch.hex)
            dot.layer.cornerRadius = 9
            dot.layer.borderWidth = 1 / UITraitCollection.current.displayScale
            dot.layer.borderColor = IOSTheme.border.cgColor
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 18), dot.heightAnchor.constraint(equalToConstant: 18)])
            dot.isAccessibilityElement = true
            dot.accessibilityLabel = "\(swatch.name) \(swatch.hex)"
            swatchRow.addArrangedSubview(dot)
        }
        swatchRow.isHidden = overview.swatches.isEmpty

        let archived = brand.status == .archived
        selectButton.setPill(title: isCurrent ? "Seçili marka" : (archived ? "Arşivde" : "Bu markayı seç"), kind: isCurrent || archived ? .secondary : .ink, image: isCurrent ? "checkmark" : nil)
        selectButton.isEnabled = !isCurrent && !archived
        chatButton.setPill(title: "Sohbette konuş", kind: .secondary)
    }
}

// MARK: - Tab strip

/// The page's sections as words with a sliding underline; scrolls sideways when they do not fit.
final class BrandTabStrip: UIView {
    var onSelect: ((BrandTab) -> Void)?
    private let scroll = UIScrollView()
    private let row = UIStackView()
    private var buttons: [UIButton] = []
    private let underline = UIView()
    private var selected: BrandTab = .general

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.canvas
        heightAnchor.constraint(equalToConstant: 46).isActive = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = false
        addSubview(scroll)
        scroll.pin(to: self)
        row.axis = .horizontal
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -8),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            // Fills the width when the words fit (wide screens), scrolls when they do not.
            row.widthAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.widthAnchor, constant: -16),
        ])
        row.distribution = .fillProportionally
        for tab in BrandTab.allCases {
            var config = UIButton.Configuration.plain()
            config.title = tab.title
            config.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
            let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.onSelect?(tab) })
            buttons.append(button)
            row.addArrangedSubview(button)
        }
        underline.backgroundColor = IOSTheme.textPrimary
        scroll.addSubview(underline)
        let hairline = BrandUI.hairline()
        addSubview(hairline)
        NSLayoutConstraint.activate([
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        select(.general)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func select(_ tab: BrandTab) {
        let changed = tab != selected
        selected = tab
        for (index, button) in buttons.enumerated() {
            let on = index == tab.rawValue
            button.configuration?.baseForegroundColor = on ? IOSTheme.textPrimary : IOSTheme.textTertiary
            // One weight for all, so the words keep their widths when the selection moves.
            button.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = IOSTheme.font(15, .semibold, style: .subheadline)
                return outgoing
            }
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        setNeedsLayout()
        guard changed, window != nil else { return }
        UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
            self.layoutIfNeeded()
        }
        // The picked word comes fully into view when the strip scrolls.
        let button = buttons[tab.rawValue]
        scroll.scrollRectToVisible(button.convert(button.bounds, to: scroll).insetBy(dx: -24, dy: 0), animated: true)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The buttons' frames first (they are laid out inside the scroll view).
        scroll.layoutIfNeeded()
        guard buttons.indices.contains(selected.rawValue) else { return }
        let button = buttons[selected.rawValue]
        let frame = button.convert(button.bounds, to: scroll)
        underline.frame = CGRect(x: frame.minX + 8, y: bounds.height - 2, width: max(frame.width - 16, 0), height: 2)
    }
}
