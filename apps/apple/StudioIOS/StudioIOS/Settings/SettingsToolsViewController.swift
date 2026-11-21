import StudioKit
import UIKit

/// Ayarlar → Araçlar: the programs Studio uses on the Mac (Claude Code, Gemini CLI, Chromium,
/// ffmpeg, Python, cloudflared, Whisper) with state, version, Studio's copy or the Mac's own,
/// source and size; Kur / Güncelle / Kaldır ask first (showing source and size) and queue a
/// `tool.install` / `tool.uninstall` job on the Mac. Progress comes live from presence `tools`
/// (the app follows the job stream); without it the list is polled while an install runs.
final class SettingsToolsViewController: SettingsTableViewController {
    private var pollTask: Task<Void, Never>?

    init(app: IOSAppModel) {
        super.init(app: app, title: "Araçlar")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    deinit { pollTask?.cancel() }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.rightBarButtonItem = UIBarButtonItem(image: UIImage(systemName: "arrow.clockwise"), primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            self.run("Mac'ten yeniden denetlemesi istendi") { try await self.store.refreshTools() }
        })
        navigationItem.rightBarButtonItem?.accessibilityLabel = "Yeniden denetle"
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        pollTask?.cancel()
        pollTask = nil
    }

    override func refresh() async {
        await store.loadTools()
        followInstalls()
    }

    /// The live list: presence `tools` when the Mac reports it there, else the last `GET /api/tools`.
    var tools: [ToolStatus] { store.currentTools }

    override func buildSections() -> [SettingsSection] {
        let list = tools
        let online = store.tools?.online ?? app.presence?.online ?? false
        if list.isEmpty {
            return [SettingsSection(footer: online ? nil : "Mac'teki worker bağlanınca araçlar listelenir.", rows: [
                .info(store.toolsError ?? (online ? "Mac araç listesini henüz bildirmedi." : "Mac çevrimdışı"), icon: "wrench.and.screwdriver"),
            ])]
        }
        let required = list.filter { !$0.optional }
        let optional = list.filter(\.optional)
        var sections = [SettingsSection(
            footer: online ? "Studio'nun Mac'te kullandığı ama içinde gelmeyen programlar. Kurulum resmi kaynaktan, Mac'e yapılır; Mac'te zaten kurulu bir kopyaya dokunulmaz." : "Mac çevrimdışı: kurulum Mac'teki worker bağlanınca yapılabilir.",
            rows: required.map(row))]
        if !optional.isEmpty {
            sections.append(SettingsSection("İsteğe bağlı", footer: "Bunlar olmadan da Studio çalışır.", rows: optional.map(row)))
        }
        return sections
    }

    private func row(_ tool: ToolStatus) -> SettingsRow {
        let warn = tool.state == .failed || tool.state == .outdated || (tool.state == .missing && !tool.optional)
        let icon: String = switch tool.state {
        case .installed: "checkmark.circle"
        case .missing: "circle.dashed"
        case .outdated: "arrow.up.circle"
        case .installing: "arrow.down.circle"
        case .failed: "exclamationmark.triangle"
        case .unknown: "questionmark.circle"
        }
        var lines = [tool.purpose, tool.statusText, tool.sourceText]
        if let note = tool.note, !note.isEmpty { lines.append(note) }
        let value: String? = if tool.canInstall { "Kur" } else if tool.canUpdate { "Güncelle" } else { nil }
        return SettingsRow(title: tool.label, detail: lines.filter { !$0.isEmpty }.joined(separator: "\n"), value: value, icon: icon,
                           tint: warn ? IOSTheme.accent : nil, kind: .navigate { [weak self] in self?.actions(for: tool) }, id: tool.id)
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = super.tableView(tableView, cellForRowAt: indexPath)
        let row = sections[indexPath.section].rows[indexPath.row]
        guard row.id != nil else { return cell }
        // The main action reads as an orange word at the end; a running install shows a spinner.
        if let tool = tools.first(where: { $0.id == row.id }), tool.state == .installing {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            cell.accessoryView = spinner
        } else if let value = row.value {
            let label = UILabel()
            label.text = value
            label.font = .preferredFont(forTextStyle: .body)
            label.textColor = store.canChange ? IOSTheme.accent : IOSTheme.textTertiary
            label.sizeToFit()
            cell.accessoryView = label
        }
        return cell
    }

    private func actions(for tool: ToolStatus) {
        let sheet = UIAlertController(title: tool.label, message: [tool.statusText, tool.sourceText].joined(separator: "\n"), preferredStyle: .actionSheet)
        let enabled = store.canChange && tool.state != .installing
        if tool.canInstall {
            let action = UIAlertAction(title: "Kur", style: .default) { [weak self] _ in self?.confirmInstall(tool, update: false) }
            action.isEnabled = enabled
            sheet.addAction(action)
        }
        if tool.canUpdate {
            let action = UIAlertAction(title: "Güncelle", style: .default) { [weak self] _ in self?.confirmInstall(tool, update: true) }
            action.isEnabled = enabled
            sheet.addAction(action)
        }
        if tool.canRemove {
            let action = UIAlertAction(title: "Kaldır", style: .destructive) { [weak self] _ in self?.confirmRemove(tool) }
            action.isEnabled = enabled
            sheet.addAction(action)
        }
        if let url = URL(string: tool.sourceUrl), url.scheme == "https" {
            sheet.addAction(UIAlertAction(title: "Kaynağı aç", style: .default) { _ in UIApplication.shared.open(url) })
        }
        sheet.addAction(UIAlertAction(title: "Kapat", style: .cancel))
        if let popover = sheet.popoverPresentationController {
            popover.sourceView = view
            popover.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        }
        present(sheet, animated: true)
    }

    private func confirmInstall(_ tool: ToolStatus, update: Bool) {
        let size = tool.sizeText.map { " · \($0)" } ?? ""
        let version = tool.targetVersion.map { " · sürüm \($0)" } ?? ""
        let message = "Kaynak: \(tool.source)\(size)\(version)\n\(tool.sourceUrl)\n\nMac'e indirilip Studio'nun klasörüne kurulur."
        confirm(update ? "\(tool.label) güncellensin mi?" : "\(tool.label) Mac'e kurulsun mu?", message: message, action: update ? "Güncelle" : "Kur", destructive: false) { [weak self] in
            guard let self else { return }
            self.run(update ? "Güncelleme başladı" : "Kurulum başladı") {
                try await self.store.installTool(tool.id, update: update)
                self.followInstalls()
            }
        }
    }

    private func confirmRemove(_ tool: ToolStatus) {
        confirm("\(tool.label) kaldırılsın mı?", message: "Studio'nun kopyası Mac'ten silinir\(tool.sizeText.map { " (\($0))" } ?? ""). Mac'te ayrıca kurulu bir kopya varsa ona dokunulmaz.", action: "Kaldır") { [weak self] in
            guard let self else { return }
            self.run("Kaldırma başladı") {
                try await self.store.uninstallTool(tool.id)
                self.followInstalls()
            }
        }
    }

    /// Without live presence `tools`, poll while something installs.
    private func followInstalls() {
        guard app.presence?.tools == nil, store.currentTools.contains(where: { $0.state == .installing }) || store.toolJobRunning else { return }
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            for _ in 0..<600 {
                try? await Task.sleep(for: .seconds(2))
                guard let self, !Task.isCancelled else { return }
                await self.store.loadTools()
                if !self.store.currentTools.contains(where: { $0.state == .installing }) { break }
            }
        }
    }
}
