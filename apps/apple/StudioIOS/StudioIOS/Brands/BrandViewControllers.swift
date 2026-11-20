import Observation
import StudioKit
import UIKit

/// What the Markalar list shows besides the brands: archived brands and each brand's kit and
/// profiles (its logo, colour and profile state), read once per brand.
@MainActor
@Observable
final class BrandListModel {
    @ObservationIgnored weak var app: IOSAppModel?
    private(set) var archived: [Brand] = []
    private(set) var kits: [EntityID: BrandKit] = [:]
    private(set) var profiles: [EntityID: [BrandProfile]] = [:]
    private(set) var isLoading = false
    private(set) var hasLoaded = false
    var error: String?

    init(app: IOSAppModel) { self.app = app }

    var all: [Brand] { (app?.brands ?? []) + archived.filter { brand in !(app?.brands.contains { $0.id == brand.id } ?? false) } }

    func overview(_ brand: Brand) -> BrandOverview {
        BrandOverview(brand: brand, kit: kits[brand.id], profile: BrandOverview.cardProfile(profiles[brand.id] ?? []), accounts: app?.accounts ?? [])
    }

    func load(refreshBrands: Bool = false) async {
        guard let app else { return }
        let service = app.dataService
        isLoading = true
        defer {
            isLoading = false
            hasLoaded = true
        }
        do {
            if refreshBrands {
                app.brands = try await service.brands()
                if let accounts = try? await service.socialAccounts(brandId: nil) { app.accounts = accounts }
            }
            archived = try await service.archivedBrands()
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
        // Kits and profiles of every brand, side by side.
        await withTaskGroup(of: (EntityID, BrandKit?, [BrandProfile]?).self) { group in
            for brand in all {
                let id = brand.id
                group.addTask {
                    async let kit = try? service.brandKit(brandId: id)
                    async let profiles = try? service.brandProfiles(brandId: id)
                    return (id, await kit, await profiles)
                }
            }
            for await (id, kit, profiles) in group {
                if let kit { self.kits[id] = kit }
                if let profiles { self.profiles[id] = profiles }
            }
        }
    }

    func changed(_ brand: Brand) {
        archived.removeAll { $0.id == brand.id }
        if brand.status == .archived { archived.append(brand) }
    }
}

/// Markalar: every brand as a row with its round mark, name, short name and language, the state
/// of its accounts and profile; "Etkin | Arşiv" in the bar, a search, "+" for a new brand. A row
/// opens the brand's page; swipes select or archive it.
final class BrandsViewController: UIViewController, UITableViewDataSource, UITableViewDelegate, UISearchResultsUpdating {
    private unowned let app: IOSAppModel
    private let model: BrandListModel
    private let tableView = UITableView(frame: .zero, style: .plain)
    private let segmented = UISegmentedControl(items: ["Etkin", "Arşiv"])
    private let search = UISearchController(searchResultsController: nil)
    private let emptyView = EmptyStateView()
    private var observation: IOSObservationToken?
    private var shown: [Brand] = []
    private var showsArchive: Bool { segmented.selectedSegmentIndex == 1 }

    init(app: IOSAppModel) {
        self.app = app
        self.model = BrandListModel(app: app)
        super.init(nibName: nil, bundle: nil)
        title = "Markalar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        segmented.selectedSegmentIndex = 0
        segmented.addAction(UIAction { [weak self] _ in self?.render() }, for: .valueChanged)
        navigationItem.titleView = segmented
        let add = UIBarButtonItem(image: UIImage(systemName: "plus"), primaryAction: UIAction { [weak self] _ in self?.createBrand() })
        add.accessibilityLabel = "Yeni marka"
        navigationItem.rightBarButtonItem = add
        search.searchResultsUpdater = self
        search.obscuresBackgroundDuringPresentation = false
        search.searchBar.placeholder = "Markalarda ara"
        navigationItem.searchController = search
        navigationItem.hidesSearchBarWhenScrolling = true

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.canvas
        tableView.dataSource = self
        tableView.delegate = self
        tableView.separatorColor = IOSTheme.hairline
        tableView.separatorInset = UIEdgeInsets(top: 0, left: IOSTheme.gutter + 52 + 14, bottom: 0, right: 0)
        tableView.register(BrandListCell.self, forCellReuseIdentifier: BrandListCell.reuse)
        tableView.topEdgeEffect.style = .soft
        tableView.contentInset.bottom = 40
        view.addSubview(tableView)
        tableView.pin(to: view)
        setContentScrollView(tableView, for: .top)
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task {
                await self?.model.load(refreshBrands: true)
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        tableView.refreshControl = refresh
        emptyView.isHidden = true
        tableView.backgroundView = emptyView

        observation = observeIOS { [weak self] in self?.render() }
        Task { await model.load() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // A brand changed on its page (archived, renamed, a new kit) shows here on the way back.
        if model.hasLoaded { Task { await model.load() } }
    }

    func updateSearchResults(for searchController: UISearchController) { render() }

    private var query: String { search.searchBar.text ?? "" }

    private func render() {
        let all = model.all
        let active = all.filter { $0.status != .archived }.count
        let archived = all.count - active
        segmented.setTitle(active > 0 ? "Etkin · \(active)" : "Etkin", forSegmentAt: 0)
        segmented.setTitle(archived > 0 ? "Arşiv · \(archived)" : "Arşiv", forSegmentAt: 1)
        segmented.sizeToFit()
        shown = BrandOverview.shown(all, archived: showsArchive, query: query)
        // Reading what each row shows makes the list follow kits, profiles and the current brand.
        _ = model.kits
        _ = model.profiles
        _ = app.currentBrandId
        _ = app.accounts
        tableView.reloadData()

        let searching = !query.trimmingCharacters(in: .whitespaces).isEmpty
        if all.isEmpty, model.hasLoaded {
            emptyView.configure(icon: "building.2", title: model.error == nil ? "Henüz marka yok" : "Markalar yüklenemedi",
                                message: model.error ?? "Yeni bir marka oluştur; kitini doldurup AI ile profilini çıkarabilirsin.",
                                actions: [UIButton.studioPill(title: "Yeni marka", kind: .primary, image: "plus") { [weak self] in self?.createBrand() }])
            emptyView.isHidden = false
        } else if shown.isEmpty, model.hasLoaded || !all.isEmpty {
            emptyView.configure(icon: searching ? "magnifyingglass" : "archivebox", title: searching ? "“\(query.trimmingCharacters(in: .whitespaces))” için marka yok" : (showsArchive ? "Arşivde marka yok" : "Etkin marka yok"), message: nil)
            emptyView.isHidden = false
        } else {
            emptyView.isHidden = true
        }
    }

    // MARK: Table

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { shown.count }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: BrandListCell.reuse, for: indexPath)
        if let cell = cell as? BrandListCell, shown.indices.contains(indexPath.row) {
            let brand = shown[indexPath.row]
            cell.configure(brand: brand, overview: model.overview(brand), profiles: model.profiles[brand.id], current: brand.id == app.currentBrandId, images: app.images)
        }
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard shown.indices.contains(indexPath.row) else { return }
        open(shown[indexPath.row])
    }

    func tableView(_ tableView: UITableView, leadingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard shown.indices.contains(indexPath.row) else { return nil }
        let brand = shown[indexPath.row]
        guard brand.status != .archived, brand.id != app.currentBrandId else { return nil }
        let select = UIContextualAction(style: .normal, title: "Seç") { [weak self] _, _, done in
            self?.select(brand)
            done(true)
        }
        select.backgroundColor = IOSTheme.accent
        select.image = UIImage(systemName: "checkmark.circle")
        return UISwipeActionsConfiguration(actions: [select])
    }

    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard shown.indices.contains(indexPath.row) else { return nil }
        let brand = shown[indexPath.row]
        let archived = brand.status == .archived
        let action = UIContextualAction(style: archived ? .normal : .destructive, title: archived ? "Arşivden çıkar" : "Arşivle") { [weak self] _, _, done in
            self?.toggleArchive(brand)
            done(true)
        }
        action.image = UIImage(systemName: archived ? "tray.and.arrow.up" : "archivebox")
        return UISwipeActionsConfiguration(actions: [action])
    }

    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard shown.indices.contains(indexPath.row) else { return nil }
        let brand = shown[indexPath.row]
        return UIContextMenuConfiguration(identifier: brand.id as NSString, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            var primary: [UIMenuElement] = [UIAction(title: "Aç", image: UIImage(systemName: "arrow.up.forward.square")) { _ in self.open(brand) }]
            if brand.status != .archived {
                primary.append(UIAction(title: "Bu markayı seç", image: UIImage(systemName: "checkmark.circle"), attributes: brand.id == self.app.currentBrandId ? .disabled : []) { _ in self.select(brand) })
                primary.append(UIAction(title: "Sohbette konuş", image: UIImage(systemName: "bubble.left.and.text.bubble.right")) { _ in
                    self.app.selectBrand(brand.id)
                    self.app.open(.newConversation)
                })
            }
            return UIMenu(children: [
                UIMenu(options: .displayInline, children: primary),
                UIAction(title: brand.status == .archived ? "Arşivden çıkar" : "Arşivle…", image: UIImage(systemName: brand.status == .archived ? "tray.and.arrow.up" : "archivebox"), attributes: brand.status == .archived ? [] : .destructive) { _ in self.toggleArchive(brand) },
            ])
        }
    }

    // MARK: Actions

    private func open(_ brand: Brand, tab: BrandTab = .general) {
        navigationItem.backButtonDisplayMode = .minimal
        navigationController?.pushViewController(BrandProfileViewController(app: app, brandId: brand.id, tab: tab), animated: true)
    }

    private func select(_ brand: Brand) {
        app.selectBrand(brand.id)
        Haptics.success()
        Toast.show("\(brand.name) seçildi", in: view)
    }

    private func toggleArchive(_ brand: Brand) {
        let archiving = brand.status != .archived
        let run = { [weak self] in
            guard let self else { return }
            Task {
                do {
                    let saved = try await self.app.dataService.updateBrand(brand.id, BrandUpdate(status: archiving ? .archived : .active))
                    if archiving {
                        self.app.brands.removeAll { $0.id == saved.id }
                        if self.app.currentBrandId == saved.id, let next = self.app.brands.first { self.app.selectBrand(next.id) }
                    } else if !self.app.brands.contains(where: { $0.id == saved.id }) {
                        self.app.brands.append(saved)
                    }
                    self.model.changed(saved)
                    Haptics.success()
                    Toast.show(archiving ? "\(brand.name) arşivlendi" : "\(brand.name) arşivden çıkarıldı", in: self.view)
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                }
            }
        }
        guard archiving else { return run() }
        confirm("\(brand.name) arşivlensin mi?", message: "Marka silinmez; listelerden kalkar, sonra geri getirilebilir.", action: "Arşivle", onConfirm: run)
    }

    /// "Yeni marka": name, short name, language. The new brand becomes the current one and its
    /// page opens on the kit (as on the Mac).
    private func createBrand() {
        let form = BrandFormViewController(mode: .create) { [weak self] name, slug, language in
            guard let self else { return "Sayfa kapandı." }
            do {
                let brand = try await self.app.dataService.createBrand(BrandCreate(name: name, slug: slug, defaultLanguage: language))
                if !self.app.brands.contains(where: { $0.id == brand.id }) { self.app.brands.append(brand) }
                self.app.selectBrand(brand.id)
                Haptics.success()
                self.segmented.selectedSegmentIndex = 0
                self.open(brand, tab: .kit)
                Toast.show("\(brand.name) oluşturuldu. Marka kitini doldurup AI ile analiz edebilirsin.", in: self.view)
                return nil
            } catch {
                return IOSAppModel.describe(error)
            }
        }
        presentSheet(form, detents: [.large()])
    }
}

/// One brand in Markalar: its round mark, the name (a seal on the current one, a tag on an
/// archived one), short name and language, then its accounts and profile state.
final class BrandListCell: UITableViewCell {
    static let reuse = "brand"
    private var mark = BrandMarkView(side: 52, images: nil)
    private let nameLabel = UILabel.studio("", size: 17, weight: .semibold, lines: 1, style: .headline)
    private let seal = UIImageView(image: UIImage(systemName: "checkmark.seal.fill"))
    private let tagLabel = UILabel.studio("", size: 12, weight: .semibold, color: IOSTheme.textSecondary, style: .caption1)
    private let subtitleLabel = UILabel.studio("", size: 14, color: IOSTheme.textSecondary, lines: 1, style: .subheadline)
    private let stateLabel = UILabel.studio("", size: 13, color: IOSTheme.textTertiary, lines: 2, style: .footnote)
    private let markHolder = UIView()

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = IOSTheme.canvas
        accessoryType = .disclosureIndicator
        markHolder.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([markHolder.widthAnchor.constraint(equalToConstant: 52), markHolder.heightAnchor.constraint(equalToConstant: 52)])
        seal.tintColor = IOSTheme.accent
        seal.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 14, weight: .semibold)
        seal.setContentHuggingPriority(.required, for: .horizontal)
        tagLabel.setContentHuggingPriority(.required, for: .horizontal)
        let nameRow = UIStackView.h([nameLabel, seal, tagLabel, UIView.spacer()], spacing: 6)
        let texts = UIStackView.v([nameRow, subtitleLabel, stateLabel], spacing: 2)
        let row = UIStackView.h([markHolder, texts], spacing: 14)
        contentView.addSubview(row)
        row.pin(to: contentView, insets: UIEdgeInsets(top: 12, left: IOSTheme.gutter, bottom: 12, right: 8))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(brand: Brand, overview: BrandOverview, profiles: [BrandProfile]?, current: Bool, images: IOSImageStore) {
        if mark.superview == nil || markHolder.subviews.isEmpty {
            mark = BrandMarkView(side: 52, images: images)
            markHolder.addSubview(mark)
            mark.pin(to: markHolder)
        }
        mark.configure(overview)
        let archived = brand.status == .archived
        nameLabel.text = brand.name
        nameLabel.textColor = archived ? IOSTheme.textSecondary : IOSTheme.textPrimary
        seal.isHidden = !current
        tagLabel.text = archived ? "Arşivde" : nil
        tagLabel.isHidden = !archived
        subtitleLabel.text = overview.subtitle
        let accounts = BrandOverview.platformsSummary(overview.platforms)
        let profile = profiles == nil ? "…" : overview.profileLine
        let waiting = (profiles ?? []).contains { draft in draft.status == .draft && draft.version > ((profiles ?? []).first { $0.isCurrent }?.version ?? 0) }
        stateLabel.text = "\(accounts.text) · \(profile)\(waiting ? " · onay bekliyor" : "")"
        stateLabel.textColor = accounts.attention || waiting ? IOSTheme.accent : IOSTheme.textTertiary
        accessibilityLabel = [brand.name, current ? "seçili marka" : nil, archived ? "arşivde" : nil, overview.subtitle, stateLabel.text].compactMap { $0 }.joined(separator: ", ")
        accessibilityHint = "Markanın sayfasını açar."
    }
}

/// Long text (DESIGN.md / VOICE.md, a skill version) in a sheet.
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
        textView.attributedText = ChatText.assistant(text, aliases: [])
        textView.adjustsFontForContentSizeCategory = true
        textView.backgroundColor = .clear
        textView.textContainerInset = UIEdgeInsets(top: 16, left: 12, bottom: 32, right: 12)
        view.addSubview(textView)
        textView.pin(to: view)
    }
}
