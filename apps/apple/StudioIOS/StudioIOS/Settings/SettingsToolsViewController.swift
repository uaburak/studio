import StudioKit
import UIKit

/// One program Studio uses on the Mac but does not carry (Ayarlar → Araçlar).
struct SettingsToolItem: Equatable {
    enum State: Equatable {
        case ready(version: String?)
        case missing
        case installing(progress: Int?)
        case failed(String)
        /// Not reported yet (the tools API is not wired).
        case unknown
    }

    /// What the row's button does (nil: no button).
    enum Action: Equatable {
        case install
        case update
        case retry
    }

    var id: String
    var title: String
    var detail: String
    var state: State
    var action: Action?

    var statusText: String {
        switch state {
        case .ready(let version): version.map { "Kurulu · \($0)" } ?? "Kurulu"
        case .missing: "Kurulu değil"
        case .installing(let progress): progress.map { "Kuruluyor… %\($0)" } ?? "Kuruluyor…"
        case .failed(let message): "Kurulamadı: \(message)"
        case .unknown: "Mac'te denetlenir"
        }
    }

    var actionTitle: String? {
        switch action {
        case .install: "Mac'e kur"
        case .update: "Güncelle"
        case .retry: "Yeniden dene"
        case nil: nil
        }
    }

    /// The programs the Mac's Ayarlar → Gelişmiş → Araçlar lists, before the Mac reports them.
    static let placeholders: [SettingsToolItem] = [
        SettingsToolItem(id: "claude", title: "Claude Code", detail: "Sohbet ve üretim (Opus, Sonnet, Haiku)", state: .unknown),
        SettingsToolItem(id: "gemini", title: "Gemini CLI", detail: "Gemini ile sohbet (API anahtarı yoksa)", state: .unknown),
        SettingsToolItem(id: "chromium", title: "Chromium", detail: "Görselleri çizer (render)", state: .unknown),
        SettingsToolItem(id: "ffmpeg", title: "ffmpeg", detail: "Reels videoları ve kesitler", state: .unknown),
        SettingsToolItem(id: "python", title: "Python", detail: "Yardımcı betikler", state: .unknown),
        SettingsToolItem(id: "cloudflared", title: "cloudflared", detail: "Uzaktan erişim tüneli", state: .unknown),
        SettingsToolItem(id: "whisper", title: "Whisper", detail: "Sesli mesajları yazıya döker", state: .unknown),
    ]
}

/// Ayarlar → Araçlar: the programs Studio uses on the Mac, each with its state and one action.
///
/// TODO(tools API): another agent is building the tools endpoints (Claude / Gemini CLI, Chromium,
/// ffmpeg, Python, cloudflared, whisper: status and install from the phone). Wire it here:
/// load the list in `refresh()` into `tools` (map each tool to a `SettingsToolItem`), and run
/// the install / update in `perform(_:on:)`. Until then the rows show the known programs with
/// "Mac'te denetlenir" and no buttons.
final class SettingsToolsViewController: SettingsTableViewController {
    /// The rows shown; set it (from the tools API) and the list rebuilds.
    var tools: [SettingsToolItem] = SettingsToolItem.placeholders {
        didSet { if isViewLoaded { rebuild() } }
    }

    init(app: IOSAppModel) {
        super.init(app: app, title: "Araçlar")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async {
        // TODO(tools API): tools = try await app.dataService.tools().map(SettingsToolItem.init)
    }

    override func buildSections() -> [SettingsSection] {
        let rows: [SettingsRow] = tools.map { tool in
            let warn: Bool = switch tool.state {
            case .missing, .failed: true
            default: false
            }
            let icon: String = switch tool.state {
            case .ready: "checkmark.circle"
            case .missing: "circle.dashed"
            case .installing: "arrow.down.circle"
            case .failed: "exclamationmark.triangle"
            case .unknown: "questionmark.circle"
            }
            let detail = "\(tool.detail)\n\(tool.statusText)"
            if let title = tool.actionTitle, let action = tool.action {
                return SettingsRow(title: tool.title, detail: detail, value: title, icon: icon, tint: warn ? IOSTheme.accent : nil, kind: .action(destructive: false) { [weak self] in
                    self?.perform(action, on: tool)
                }, enabled: store.canChange, id: tool.id)
            }
            return SettingsRow(title: tool.title, detail: detail, icon: icon, tint: warn ? IOSTheme.accent : nil, id: tool.id)
        }
        return [SettingsSection(footer: "Studio'nun Mac'te kullandığı ama içinde gelmeyen programlar. Kurulum Mac'te yapılır.", rows: rows)]
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = super.tableView(tableView, cellForRowAt: indexPath)
        let row = sections[indexPath.section].rows[indexPath.row]
        // Action rows keep the tool's name in the normal colour and show the button text trailing.
        if case .action = row.kind, var content = cell.contentConfiguration as? UIListContentConfiguration {
            content.textProperties.color = IOSTheme.textPrimary
            cell.contentConfiguration = content
            let label = UILabel()
            label.text = row.value
            label.font = .preferredFont(forTextStyle: .body)
            label.textColor = row.enabled ? IOSTheme.accent : IOSTheme.textTertiary
            label.sizeToFit()
            cell.accessoryView = label
        }
        return cell
    }

    private func perform(_ action: SettingsToolItem.Action, on tool: SettingsToolItem) {
        // TODO(tools API): start the install / update on the Mac and follow its progress.
        Toast.show("\(tool.title): Mac'te kurulum yakında buradan başlatılabilecek.", in: view)
    }
}
