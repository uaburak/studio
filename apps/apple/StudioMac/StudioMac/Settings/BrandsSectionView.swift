import AppKit
import StudioKit

/// Settings → "Markalar" in Claude's tabs + table layout: "Etkin | Arşiv" tabs, a search field
/// and "+ Yeni marka" on top; a table of brands (language, connected platforms, "Ayarlar" /
/// "Geri yükle").
final class BrandsSectionView: SettingsPaneView {
    enum Tab: Int, CaseIterable {
        case active, archived

        var title: String {
            switch self {
            case .active: "Etkin"
            case .archived: "Arşiv"
            }
        }
    }

    private unowned let app: AppModel
    let toolbar: SettingsTableToolbar
    let table = SettingsTableBlock(columns: [
        .init(title: "Marka", width: nil),
        .init(title: "Dil", width: 100),
        .init(title: "Hesaplar", width: 110),
        .init(title: "", width: 104),
    ])
    private(set) var tab: Tab = .active
    private var signature = ""
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        let tabs = SettingsTabsView(titles: Tab.allCases.map(\.title))
        let create = PillButton(title: "+ Yeni marka", kind: .ink, height: 26) { [weak app] in
            app?.settingsPresented = false
            app?.newBrandPresented = true
        }
        create.toolTip = SettingsCatalog.newBrand.detail
        toolbar = SettingsTableToolbar(tabs: tabs, searchPlaceholder: "Markalarda ara", trailing: [create])
        super.init(section: .brands)
        // The toolbar answers "yeni marka" in the settings search (its button creates one).
        add(SettingsCustomBlock(toolbar, searchText: SettingsCatalog.newBrand.searchText, verticalPadding: 8))
        add(table)
        tabs.onSelect = { [weak self] index in self?.show(Tab(rawValue: index) ?? .active) }
        toolbar.searchField.target = self
        toolbar.searchField.action = #selector(localSearchChanged)
        observation = observe { [weak self] in self?.render() }
        Task { await app.refreshArchivedBrands() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func show(_ next: Tab) {
        tab = next
        if toolbar.tabs.selectedIndex != next.rawValue { toolbar.tabs.selectedIndex = next.rawValue }
        signature = ""
        render()
    }

    @objc private func localSearchChanged() {
        table.localQuery = toolbar.searchField.stringValue
        refresh()
    }

    /// Types into the toolbar's search field (keyboard shortcuts, tests).
    func searchLocally(_ text: String) {
        toolbar.searchField.stringValue = text
        localSearchChanged()
    }

    private func render() {
        let active = app.brands.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        let archived = app.archivedBrands
        let shown = tab == .active ? active : archived
        let accounts = app.accounts
        let next = ["\(tab)", app.currentBrandId ?? "-"] + shown.map { brand in
            "\(brand.id):\(brand.name):\(brand.status.rawValue):\(brand.defaultLanguage):" + accounts.filter { $0.brandId == brand.id && $0.status == .connected }.map(\.platform.rawValue).sorted().joined()
        }
        let joined = next.joined(separator: "|")
        guard joined != signature else { return }
        signature = joined
        table.emptyText = tab == .active ? "Henüz marka yok." : "Arşivde marka yok."
        table.setRows(shown.map(row))
        refresh()
    }

    private func row(_ brand: Brand) -> SettingsTableBlock.Row {
        let archived = brand.status == .archived
        let current = brand.id == app.currentBrandId
        let connected = Platform.knownCases.filter { platform in
            app.accounts.contains { $0.brandId == brand.id && $0.platform == platform && $0.status == .connected }
        }
        let action: NSView
        if archived {
            action = PillButton(title: "Geri yükle", kind: .secondary, height: 26) { [weak self] in self?.restore(brand) }
        } else {
            action = PillButton(title: "Ayarlar", kind: .secondary, height: 26) { [weak app] in
                app?.settingsPresented = false
                app?.openBrandSettings(brand.id)
            }
        }
        action.setAccessibilityLabel("\(brand.name): \(archived ? "geri yükle" : "ayarlar")")
        let menu = NSMenu()
        if !archived {
            menu.addItem(ClosureMenuItem(title: "Bu markaya geç") { [weak app] in _ = app?.switchToBrand(brand.id) })
            menu.addItem(ClosureMenuItem(title: "Marka ayarları…") { [weak app] in
                app?.settingsPresented = false
                app?.openBrandSettings(brand.id)
            })
        } else {
            menu.addItem(ClosureMenuItem(title: "Geri yükle") { [weak self] in self?.restore(brand) })
        }
        return SettingsTableBlock.Row(
            id: brand.id,
            searchText: "\(brand.name) \(brand.slug) \(BrandLanguage.label(brand.defaultLanguage)) marka \(archived ? "arşiv" : "")",
            cells: [
                SettingsTableCells.title(brand.name, subtitle: brand.slug, tag: current ? "Seçili" : (archived ? "Arşiv" : nil), initials: BrandCardContent.initials(brand.name)),
                SettingsTableCells.text(BrandLanguage.label(brand.defaultLanguage)),
                SettingsTableCells.symbols(connected.map(\.panelSymbol), help: connected.map(\.displayName).joined(separator: ", ")),
                action,
            ],
            dimmed: archived,
            menu: menu
        )
    }

    private func restore(_ brand: Brand) {
        Task { @MainActor in
            do {
                try await app.restoreBrand(brand.id)
            } catch {
                app.show(error: error)
            }
        }
    }
}
