import AppKit
import StudioKit

/// Settings → "Markalar": every brand (active and archived) with its settings and
/// archive / restore, plus the first-run guide.
final class BrandsSectionView: NSView {
    private unowned let app: AppModel
    private let group = SettingsGroupCardView(title: "Markalar")
    private let list = BrandUI.vstack(spacing: 8)
    private var signature = ""
    private var observation: ObservationToken?

    init(app: AppModel) {
        self.app = app
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        addSubview(group)
        NSLayoutConstraint.activate([
            group.leadingAnchor.constraint(equalTo: leadingAnchor),
            group.trailingAnchor.constraint(equalTo: trailingAnchor),
            group.topAnchor.constraint(equalTo: topAnchor),
            group.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        group.addFullWidth(list)
        let newBrand = PillButton(title: "Yeni marka…", kind: .secondary, height: 24) { [weak app] in
            app?.settingsPresented = false
            app?.newBrandPresented = true
        }
        let guide = PillButton(title: "Başlangıç rehberi", kind: .secondary, height: 24) { [weak app] in
            app?.settingsPresented = false
            app?.onboarding.reopen()
        }
        guide.isHidden = app.isSample
        group.stack.addArrangedSubview(BrandUI.hstack([newBrand, guide]))
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
        list.arrangedSubviews.forEach { $0.removeFromSuperview() }
        if active.isEmpty && archived.isEmpty {
            BrandUI.addFull(BrandUI.note("Henüz marka yok."), to: list)
            return
        }
        for brand in active { BrandUI.addFull(row(brand), to: list) }
        if !archived.isEmpty {
            list.addArrangedSubview(BrandUI.caption("Arşivdekiler"))
            for brand in archived { BrandUI.addFull(row(brand), to: list) }
        }
    }

    private func row(_ brand: Brand) -> NSView {
        let archived = brand.status == .archived
        let name = NSTextField.styledLabel(brand.name, font: Theme.rowFont, color: archived ? Theme.textSecondary : Theme.textPrimary)
        name.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        var detail = "\(brand.slug) · \(BrandLanguage.label(brand.defaultLanguage))"
        if brand.id == app.currentBrandId { detail += " · seçili" }
        let meta = NSTextField.styledLabel(detail, font: Theme.smallFont, color: Theme.textTertiary)
        let open = PillButton(title: "Ayarlar…", kind: .secondary, height: 24) { [weak app] in
            app?.settingsPresented = false
            app?.openBrandSettings(brand.id)
        }
        var views: [NSView] = [BrandUI.vstack([name, meta], spacing: 1), BrandUI.spacer()]
        if archived {
            let restore = PillButton(title: "Geri yükle", kind: .secondary, height: 24) { [weak self] in self?.restore(brand) }
            views += [restore, open]
        } else {
            views.append(open)
        }
        return BrandUI.hstack(views, spacing: 8)
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
