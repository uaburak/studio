import AppKit
import StudioKit

/// Settings → "Markalar": every brand (active and archived) as a row with its
/// settings and restore, plus "Yeni marka".
final class BrandsSectionView: SettingsPaneView {
    private unowned let app: AppModel
    private let list = SettingsGroupBlock()
    private var signature = ""
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(section: .brands)
        add(list)
        let create = PillButton(title: "Oluştur", kind: .secondary, height: 26) { [weak app] in
            app?.settingsPresented = false
            app?.newBrandPresented = true
        }
        addRow(SettingsCatalog.newBrand, accessory: create)
        observation = observe { [weak self] in self?.render() }
        Task { await app.refreshArchivedBrands() }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private func render() {
        let active = app.brands.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
        let archived = app.archivedBrands
        let next = (active + archived).map { "\($0.id):\($0.name):\($0.status.rawValue):\($0.id == app.currentBrandId)" }.joined(separator: "|")
        guard next != signature else { return }
        signature = next
        var blocks: [SettingsBlock] = active.map(row)
        if active.isEmpty && archived.isEmpty {
            blocks.append(SettingsNoteView("Henüz marka yok."))
        }
        if !archived.isEmpty {
            blocks.append(SettingsSubheaderView("Arşiv"))
            blocks += archived.map(row)
        }
        list.setBlocks(blocks)
    }

    private func row(_ brand: Brand) -> SettingsRowView {
        let archived = brand.status == .archived
        var detail = "\(brand.slug) · \(BrandLanguage.label(brand.defaultLanguage))"
        if brand.id == app.currentBrandId { detail += " · seçili" }
        let open = PillButton(title: "Ayarlar", kind: .secondary, height: 26) { [weak app] in
            app?.settingsPresented = false
            app?.openBrandSettings(brand.id)
        }
        var buttons: [NSView] = []
        if archived {
            buttons.append(PillButton(title: "Geri yükle", kind: .secondary, height: 26) { [weak self] in self?.restore(brand) })
        }
        buttons.append(open)
        let row = SettingsRowView(title: brand.name, detail: detail, accessory: SettingsControls.buttons(buttons), keywords: archived ? "arşiv marka" : "marka")
        if archived { row.titleColor = Theme.textSecondary }
        return row
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
