import StudioKit
import UIKit

/// Ayarlar → Gelişmiş: the technical side of the Mac connection, for when something needs a
/// closer look. Normal use never needs this screen: the phone finds its Mac by itself.
/// - Bağlantı: the address in use and the routes the Mac sent (LAN, Bonjour, tunnel).
/// - Ek uzak adres: an extra address to try after the Mac's own ones.
/// - Aynı Wi-Fi'deki Mac'ler: Bonjour results; pair with a code to a specific Mac or address.
/// - Bu iPhone: name and device id.
final class IOSAdvancedConnectionViewController: UITableViewController {
    private enum Section: Int, CaseIterable {
        case link, remote, nearby, device

        var title: String? {
            switch self {
            case .link: "Bağlantı"
            case .remote: "Ek uzak adres"
            case .nearby: "Aynı Wi-Fi'deki Mac'ler"
            case .device: "Bu iPhone"
            }
        }
    }

    private struct Row {
        var title: String
        var detail: String?
        var toggle: Bool?
        var onToggle: ((Bool) -> Void)?
        var action: (() -> Void)?
    }

    private unowned let app: IOSAppModel
    private var rows: [Section: [Row]] = [:]
    private var discovered: [DiscoveredStudio] = []
    private var bonjourTask: Task<Void, Never>?
    private var observation: IOSObservationToken?

    /// Row titles per section (tests).
    var rowTitles: [String] { Section.allCases.flatMap { rows[$0]?.map(\.title) ?? [] } }

    init(app: IOSAppModel) {
        self.app = app
        super.init(style: .insetGrouped)
        title = "Gelişmiş"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit { bonjourTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .never
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        observation = observeIOS { [weak self] in self?.rebuild() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        guard !app.isSample, !AppDelegate.isUnderTest else { return }
        let browser = StudioBrowser()
        bonjourTask?.cancel()
        bonjourTask = Task { @MainActor [weak self] in
            for await list in browser.results() {
                guard let self, !Task.isCancelled else { return }
                self.discovered = list
                self.rebuild()
            }
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        bonjourTask?.cancel()
        bonjourTask = nil
    }

    private static func describe(_ kind: MacRoute.Kind) -> String {
        switch kind {
        case .bonjour: "yerel ağ (Bonjour)"
        case .lastKnown: "son kullanılan adres"
        case .lan: "yerel ağ"
        case .tunnel: "uzaktan erişim tüneli"
        case .manual: "ek uzak adres"
        }
    }

    private func rebuild() {
        let settings = app.settings
        let credential = settings.savedCredential
        var rows: [Section: [Row]] = [:]

        var link: [Row] = []
        if case .connected(let route) = app.linkPhase {
            link.append(Row(title: "Kullanılan adres", detail: "\(route.url.absoluteString) · \(Self.describe(route.kind))"))
        } else {
            link.append(Row(title: "Kullanılan adres", detail: credential.map { "Son: \($0.serverURL.absoluteString)" } ?? "—"))
        }
        let routes = credential?.routes
        let lan = routes?.lanURLs.map(\.absoluteString) ?? []
        link.append(Row(title: "Yerel ağ adresleri", detail: lan.isEmpty ? "Mac henüz bildirmedi" : lan.joined(separator: "\n")))
        link.append(Row(title: "Bonjour adı", detail: credential?.bonjourName ?? "—"))
        link.append(Row(title: "Uzaktan erişim tüneli", detail: routes?.tunnelUrl?.absoluteString ?? "Mac'te ayarlı değil"))
        link.append(Row(title: "Mac kimliği", detail: credential?.macId.map { String($0.prefix(8)) } ?? "—"))
        if let updated = routes?.updatedAt {
            link.append(Row(title: "Mac'ten son bilgi", detail: updated.formatted(date: .abbreviated, time: .shortened)))
        }
        link.append(Row(title: "Şimdi yeniden ara", action: { [weak self] in
            self?.app.retryConnection()
            Toast.show(MacLinkState.connecting.title, in: self?.view)
        }))
        rows[.link] = link

        rows[.remote] = [
            Row(title: "Bu adresi de dene", detail: "Mac'in kendi adreslerinden sonra denenir.", toggle: settings.useRemoteControlURL, onToggle: { [weak self] on in
                self?.app.settings.useRemoteControlURL = on
                self?.app.retryConnection()
            }),
            Row(title: "Adres", detail: settings.remoteURLString.isEmpty ? "—" : settings.remoteURLString, action: { [weak self] in
                guard let self else { return }
                self.prompt("Ek uzak adres", message: "Ör. Mac'teki Uzaktan erişim adresi (https://…).", text: self.app.settings.remoteURLString, placeholder: IOSAppSettings.defaultRemoteURLString, keyboard: .URL) { text in
                    self.app.settings.remoteURLString = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    if !text.isEmpty, self.app.settings.remoteURL == nil { self.presentError("Geçerli bir https:// adresi gir.") }
                    if self.app.settings.useRemoteControlURL { self.app.retryConnection() }
                }
            }),
        ]

        var nearby: [Row] = discovered.map { studio in
            let addresses = studio.advertisedURLs.map(\.absoluteString).joined(separator: ", ")
            return Row(title: studio.displayName, detail: addresses.isEmpty ? "Kodla bağlanmak için dokun" : addresses, action: { [weak self] in
                self?.pairWithCode(studio)
            })
        }
        if discovered.isEmpty { nearby.append(Row(title: "Aranıyor…", detail: "Mac'te Studio açık ve yerel ağdan erişim açık olmalı.")) }
        nearby.append(Row(title: "Adresle bağlan…", detail: "Adres ve Mac'teki 6 haneli kod", action: { [weak self] in
            self?.openCodeEntry(url: nil, name: "Mac")
        }))
        rows[.nearby] = nearby

        rows[.device] = [
            Row(title: UIDevice.current.name, detail: credential.map { "Cihaz no: \($0.deviceId.suffix(8))" } ?? MacLinkState.notPaired.title),
        ]

        self.rows = rows
        tableView.reloadData()
    }

    private func pairWithCode(_ studio: DiscoveredStudio) {
        Task {
            do {
                let url = try await StudioBrowser.resolve(studio)
                openCodeEntry(url: url, name: studio.displayName)
            } catch {
                openCodeEntry(url: studio.advertisedURLs.first, name: studio.displayName)
            }
        }
    }

    private func openCodeEntry(url: URL?, name: String) {
        let vc = PairingSheetViewController(app: app, baseURL: url, serverName: name, asksAddress: true) { [weak self] in
            Toast.show("Mac'e bağlandı", in: self?.view)
        }
        presentSheet(vc, detents: [.large()])
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { Section.allCases.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        rows[Section(rawValue: section)!]?.count ?? 0
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        Section(rawValue: section)?.title
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        Section(rawValue: section) == .link
            ? "iPhone bu adresleri sırayla dener: aynı Wi-Fi'de Bonjour, son kullanılan adres, Mac'in yerel adresleri, sonra tünel."
            : nil
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        guard let row = rows[Section(rawValue: indexPath.section)!]?[indexPath.row] else { return cell }
        var content = UIListContentConfiguration.subtitleCell()
        content.text = row.title
        content.textProperties.color = row.action != nil && row.detail == nil ? IOSTheme.accent : IOSTheme.textPrimary
        content.secondaryText = row.detail
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.secondaryTextProperties.numberOfLines = 0
        cell.contentConfiguration = content
        cell.accessoryView = nil
        cell.accessoryType = row.action != nil && row.detail != nil ? .disclosureIndicator : .none
        cell.selectionStyle = row.action == nil ? .none : .default
        if let toggle = row.toggle {
            let toggleView = UISwitch()
            toggleView.isOn = toggle
            toggleView.onTintColor = IOSTheme.ink
            let handler = row.onToggle
            toggleView.addAction(UIAction { [weak toggleView] _ in handler?(toggleView?.isOn ?? false) }, for: .valueChanged)
            cell.accessoryView = toggleView
            cell.selectionStyle = .none
        }
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        rows[Section(rawValue: indexPath.section)!]?[indexPath.row].action?()
    }
}
