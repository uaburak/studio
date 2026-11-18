import StudioKit
import UIKit

/// Brands: switch the current brand, open a brand's profile.
final class BrandsViewController: UITableViewController {
    private unowned let app: IOSAppModel
    private var observation: IOSObservationToken?

    init(app: IOSAppModel) {
        self.app = app
        super.init(style: .insetGrouped)
        title = "Markalar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "brand")
        observation = observeIOS { [weak self] in
            guard let self else { return }
            _ = self.app.brands
            _ = self.app.currentBrandId
            self.tableView.reloadData()
        }
    }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { max(1, app.brands.count) }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        "Yeni marka, marka kiti ve profil çıkarma Mac'te yapılır. Buradan profili görüp taslağı onaylayabilirsin."
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "brand", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        var content = UIListContentConfiguration.subtitleCell()
        guard app.brands.indices.contains(indexPath.row) else {
            content.text = "Marka yok"
            content.secondaryText = "Mac'te yeni marka oluştur (⇧⌘N)."
            cell.contentConfiguration = content
            return cell
        }
        let brand = app.brands[indexPath.row]
        content.text = brand.name
        let accounts = app.accounts(of: brand.id).map { "\($0.platform.displayName) \($0.handle)" }
        content.secondaryText = ([brand.slug] + accounts).joined(separator: " · ")
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        cell.contentConfiguration = content
        cell.accessoryType = .detailButton
        cell.tintColor = IOSTheme.ink
        if brand.id == app.currentBrandId {
            let check = UIImageView(image: UIImage(systemName: "checkmark"))
            check.tintColor = IOSTheme.ink
            cell.accessoryView = nil
            cell.accessoryType = .checkmark
            _ = check
        }
        cell.accessibilityHint = "Seçer. Profil için ayrıntı düğmesi."
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard app.brands.indices.contains(indexPath.row) else { return }
        let brand = app.brands[indexPath.row]
        app.selectBrand(brand.id)
        navigationController?.pushViewController(BrandProfileViewController(app: app, brandId: brand.id), animated: true)
    }

    override func tableView(_ tableView: UITableView, accessoryButtonTappedForRowWith indexPath: IndexPath) {
        guard app.brands.indices.contains(indexPath.row) else { return }
        navigationController?.pushViewController(BrandProfileViewController(app: app, brandId: app.brands[indexPath.row].id), animated: true)
    }
}

/// A brand's profile: accounts, palette and kit summary, the approved profile (DESIGN.md,
/// VOICE.md) and a newer draft to approve.
final class BrandProfileViewController: UIViewController {
    private unowned let app: IOSAppModel
    let brandId: EntityID
    private let stack = UIStackView.v([], spacing: 14)
    private var profiles: [BrandProfile] = []
    private var kit: BrandKit?
    /// The kit could not be read (shown instead of silently treating it as empty).
    private var kitError: String?
    private var isLoading = true
    private var isBusy = false
    private var loadError: String?

    init(app: IOSAppModel, brandId: EntityID) {
        self.app = app
        self.brandId = brandId
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var brand: Brand? { app.brand(brandId) }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        title = brand?.name ?? "Marka"
        navigationItem.largeTitleDisplayMode = .never
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        view.addSubview(scroll)
        scroll.pin(to: view)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -32),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * IOSTheme.gutter),
        ])
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task {
                await self?.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        scroll.refreshControl = refresh
        render()
        Task { await load() }
    }

    private func load() async {
        isLoading = true
        do {
            async let loadedProfiles = app.dataService.brandProfiles(brandId: brandId)
            async let loadedKit = app.dataService.brandKit(brandId: brandId)
            profiles = try await loadedProfiles.sorted { $0.version > $1.version }
            do {
                kit = try await loadedKit
                kitError = nil
            } catch {
                kitError = "Marka kiti okunamadı: \(IOSAppModel.describe(error))"
            }
            loadError = nil
        } catch {
            loadError = IOSAppModel.describe(error)
        }
        isLoading = false
        render()
    }

    private var current: BrandProfile? { profiles.first { $0.isCurrent } ?? profiles.first { $0.status == .approved } }
    private var draft: BrandProfile? {
        profiles.first { $0.status == .draft && $0.version > (current?.version ?? 0) }
    }

    private func render() {
        stack.removeAllArranged()
        guard let brand else {
            stack.addArrangedSubview(UILabel.studio("Marka bulunamadı.", size: 15, color: IOSTheme.textSecondary))
            return
        }
        // Header
        let header = IOSCardView(padding: 16, spacing: 6)
        header.stack.addArrangedSubview(UILabel.studio(brand.name, size: 22, weight: .bold, lines: 0, style: .title2))
        header.stack.addArrangedSubview(UILabel.studio("\(brand.slug) · \(brand.defaultLanguage.uppercased())", size: 14, color: IOSTheme.textSecondary, style: .subheadline))
        if brand.id != app.currentBrandId {
            header.stack.addArrangedSubview(UIStackView.h([UIButton.studioPill(title: "Bu markaya geç", kind: .ink) { [weak self] in
                guard let self else { return }
                self.app.selectBrand(brand.id)
                Haptics.selection()
                self.render()
            }, UIView.spacer()], spacing: 0))
        } else {
            header.stack.addArrangedSubview(UILabel.studio("Seçili marka", size: 12, weight: .semibold, color: IOSTheme.textTertiary, style: .caption1))
        }
        stack.addArrangedSubview(header)

        // Accounts
        let accounts = app.accounts(of: brand.id)
        let accountsCard = IOSCardView(padding: 16, spacing: 8)
        accountsCard.stack.addArrangedSubview(sectionTitle("Hesaplar"))
        if accounts.isEmpty {
            accountsCard.stack.addArrangedSubview(UILabel.studio("Bağlı hesap yok. Hesaplar Mac'te Ayarlar → Hesaplar'da bağlanır.", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        for account in accounts {
            let health = account.tokenHealth.map { " · \($0.rawValue)" } ?? ""
            let line = UIStackView.h([
                IOSStatusDotView(color: account.status == .connected ? IOSTheme.textSecondary : IOSTheme.accent, size: 7),
                UILabel.studio("\(account.platform.displayName) · \(account.handle)", size: 15, style: .subheadline),
                UIView.spacer(),
                UILabel.studio("\(account.status.rawValue)\(health)", size: 12, color: IOSTheme.textTertiary, style: .caption1),
            ], spacing: 8)
            accountsCard.stack.addArrangedSubview(line)
        }
        stack.addArrangedSubview(accountsCard)

        if isLoading && profiles.isEmpty {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            stack.addArrangedSubview(spinner)
            return
        }
        if let loadError {
            stack.addArrangedSubview(UILabel.studio(loadError, size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline))
        }

        // Draft waiting for approval
        if let draft {
            let card = IOSCardView(padding: 16, spacing: 10)
            card.layer.borderColor = IOSTheme.accent.withAlphaComponent(0.6).cgColor
            card.stack.addArrangedSubview(UIStackView.h([IOSStatusDotView(color: IOSTheme.accent, size: 7), UILabel.studio("Onayın bekleniyor", size: 12, weight: .semibold, color: IOSTheme.accent, style: .caption1), UIView.spacer()], spacing: 6))
            card.stack.addArrangedSubview(UILabel.studio("Profil taslağı v\(draft.version)", size: 17, weight: .semibold, style: .headline))
            card.stack.addArrangedSubview(UILabel.studio("Onaylanınca yeni postlar bu kurallarla üretilir. \(AssistantStatus.relative(draft.updatedAt)) güncellendi.", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
            let approve = UIButton.studioPill(title: "Taslağı onayla", kind: .primary) { [weak self] in self?.approve(draft) }
            approve.configuration?.showsActivityIndicator = isBusy
            approve.isEnabled = !isBusy
            let view = UIButton.studioPill(title: "İncele", kind: .secondary) { [weak self] in self?.showProfile(draft) }
            card.stack.addArrangedSubview(UIStackView.h([approve, view, UIView.spacer()], spacing: 8))
            stack.addArrangedSubview(card)
        }

        // Palette and kit
        if let kitError {
            let card = IOSCardView(padding: 16, spacing: 8)
            card.stack.addArrangedSubview(sectionTitle("Marka kiti"))
            card.stack.addArrangedSubview(UILabel.studio(kitError, size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline))
            stack.addArrangedSubview(card)
        } else if let kit, kit.updatedAt != nil || !kit.palette.isEmpty {
            let card = IOSCardView(padding: 16, spacing: 10)
            card.stack.addArrangedSubview(sectionTitle("Marka kiti"))
            if !kit.palette.isEmpty {
                let swatches = UIStackView.h(kit.palette.prefix(10).map { color in
                    let swatch = UIView()
                    swatch.translatesAutoresizingMaskIntoConstraints = false
                    swatch.backgroundColor = UIColor(hexString: color.hex) ?? IOSTheme.fill
                    swatch.layer.cornerRadius = 14
                    swatch.layer.borderWidth = 1
                    swatch.layer.borderColor = IOSTheme.border.cgColor
                    swatch.isAccessibilityElement = true
                    swatch.accessibilityLabel = "\(color.name) \(color.hex)"
                    NSLayoutConstraint.activate([swatch.widthAnchor.constraint(equalToConstant: 28), swatch.heightAnchor.constraint(equalToConstant: 28)])
                    return swatch
                } + [UIView.spacer()], spacing: 6)
                card.stack.addArrangedSubview(swatches)
            }
            let summary = "\(kit.samples.count) örnek post · \(kit.logos.count) logo · \(kit.fonts.count) font"
            card.stack.addArrangedSubview(UILabel.studio(summary, size: 14, color: IOSTheme.textSecondary, style: .subheadline))
            if !kit.fonts.isEmpty {
                let names = kit.fonts.map { $0.isSystem ? "\($0.family) (Mac'te yüklü)" : $0.family }
                card.stack.addArrangedSubview(UILabel.studio(names.joined(separator: ", "), size: 14, lines: 0, style: .subheadline))
            }
            stack.addArrangedSubview(card)
        }

        // Approved profile
        if let current {
            let card = IOSCardView(padding: 16, spacing: 10)
            card.stack.addArrangedSubview(sectionTitle("Onaylı profil · v\(current.version)"))
            if let approved = current.approvedAt {
                card.stack.addArrangedSubview(UILabel.studio("Onay: \(TurkishFormat.dayAndTime(approved))", size: 13, color: IOSTheme.textSecondary, style: .footnote))
            }
            card.stack.addArrangedSubview(textBlock("Tasarım kuralları (DESIGN.md)", current.designRules))
            card.stack.addArrangedSubview(textBlock("Ses tonu (VOICE.md)", current.voice))
            stack.addArrangedSubview(card)
        } else if draft == nil {
            let card = IOSCardView(padding: 16, spacing: 8)
            card.stack.addArrangedSubview(sectionTitle("Profil yok"))
            card.stack.addArrangedSubview(UILabel.studio("Mac'te Markalar → \(brand.name) → Marka Kiti'ne 3–12 örnek post ekleyip “AI ile analiz et”e bas; taslak burada onaya düşer.", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
            let analyze = UIButton.studioPill(title: "Profili çıkar", kind: .secondary, image: "wand.and.stars") { [weak self] in self?.analyze() }
            analyze.isEnabled = kitError == nil && (kit?.samples.count ?? 0) >= BrandKit.minSamples && !isBusy
            card.stack.addArrangedSubview(UIStackView.h([analyze, UIView.spacer()], spacing: 0))
            stack.addArrangedSubview(card)
        }

        if profiles.count > 1 {
            let history = IOSCardView(padding: 16, spacing: 6)
            history.stack.addArrangedSubview(sectionTitle("Sürümler"))
            for profile in profiles {
                let status = profile.isCurrent ? "geçerli" : (profile.status == .approved ? "onaylı" : "taslak")
                let button = UIButton.studioPill(title: "v\(profile.version) · \(status) · \(AssistantStatus.relative(profile.updatedAt))", kind: .plain) { [weak self] in self?.showProfile(profile) }
                button.contentHorizontalAlignment = .leading
                history.stack.addArrangedSubview(button)
            }
            stack.addArrangedSubview(history)
        }
    }

    private func sectionTitle(_ text: String) -> UILabel {
        let label = UILabel.studio(text, size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote)
        label.accessibilityTraits = .header
        return label
    }

    private func textBlock(_ title: String, _ text: String) -> UIView {
        let titleLabel = UILabel.studio(title, size: 14, weight: .semibold, style: .subheadline)
        let body = UILabel.studio(text.isEmpty ? "—" : text, size: 14, color: text.isEmpty ? IOSTheme.textTertiary : IOSTheme.textPrimary, lines: 12, style: .subheadline)
        body.lineBreakMode = .byTruncatingTail
        var views: [UIView] = [titleLabel, body]
        if text.split(separator: "\n").count > 12 || text.count > 700 {
            views.append(UIStackView.h([UIButton.studioPill(title: "Tamamını göster", kind: .plain) { [weak self] in
                self?.presentSheet(TextReaderViewController(title: title, text: text), detents: [.large()])
            }, UIView.spacer()], spacing: 0))
        }
        return UIStackView.v(views, spacing: 4)
    }

    private func showProfile(_ profile: BrandProfile) {
        let text = "# DESIGN.md\n\n\(profile.designRules)\n\n# VOICE.md\n\n\(profile.voice)"
        presentSheet(TextReaderViewController(title: "Profil v\(profile.version)", text: text), detents: [.large()])
    }

    private func approve(_ draft: BrandProfile) {
        confirm("Profil v\(draft.version) onaylansın mı?", message: "Yeni postlar bu kurallar ve ses tonuyla üretilir.", action: "Onayla", destructive: false) { [weak self] in
            guard let self else { return }
            self.isBusy = true
            self.render()
            Task {
                do {
                    _ = try await self.app.dataService.approveBrandProfile(brandId: self.brandId, version: draft.version)
                    Haptics.success()
                    Toast.show("Profil v\(draft.version) onaylandı", in: self.view)
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                }
                self.isBusy = false
                await self.load()
            }
        }
    }

    private func analyze() {
        isBusy = true
        render()
        Task {
            do {
                _ = try await app.dataService.analyzeBrand(brandId: brandId, notes: nil)
                Toast.show("Profil çıkarılıyor; bitince bildirim gelir.", in: view)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
            isBusy = false
            render()
        }
    }
}

/// Long text (DESIGN.md / VOICE.md) in a sheet.
final class TextReaderViewController: UIViewController {
    private let text: String

    init(title: String, text: String) {
        self.text = text
        super.init(nibName: nil, bundle: nil)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let textView = UITextView()
        textView.translatesAutoresizingMaskIntoConstraints = false
        textView.isEditable = false
        textView.text = text
        textView.font = IOSTheme.font(15)
        textView.adjustsFontForContentSizeCategory = true
        textView.textColor = IOSTheme.textPrimary
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 32, right: 12)
        view.addSubview(textView)
        textView.pin(to: view)
    }
}
