import StudioKit
import UIKit

/// One row of an Ayarlar list: a system cell (title, secondary text, trailing value) and what it
/// does: open a screen, run an action, flip an orange switch, pick from a native menu.
struct SettingsRow {
    enum Kind {
        /// Read-only: title, secondary text, trailing value.
        case info
        /// Disclosure indicator; pushes or presents something.
        case navigate(() -> Void)
        /// A tappable row in the accent colour (or red when `destructive`).
        case action(destructive: Bool, () -> Void)
        /// An orange `UISwitch`.
        case toggle(isOn: Bool, (Bool) -> Void)
        /// A native pop-up menu (the trailing value is the current choice).
        case menu(UIMenu)
    }

    var title: String
    var detail: String?
    /// Trailing text (value cell style).
    var value: String?
    var icon: String?
    var tint: UIColor?
    var kind: Kind = .info
    var enabled = true
    var id: String?

    static func info(_ title: String, detail: String? = nil, value: String? = nil, icon: String? = nil, tint: UIColor? = nil) -> SettingsRow {
        SettingsRow(title: title, detail: detail, value: value, icon: icon, tint: tint)
    }

    static func navigate(_ title: String, detail: String? = nil, value: String? = nil, icon: String? = nil, tint: UIColor? = nil, enabled: Bool = true, _ open: @escaping () -> Void) -> SettingsRow {
        SettingsRow(title: title, detail: detail, value: value, icon: icon, tint: tint, kind: .navigate(open), enabled: enabled)
    }

    static func action(_ title: String, detail: String? = nil, icon: String? = nil, destructive: Bool = false, enabled: Bool = true, _ run: @escaping () -> Void) -> SettingsRow {
        SettingsRow(title: title, detail: detail, icon: icon, kind: .action(destructive: destructive, run), enabled: enabled)
    }

    static func toggle(_ title: String, detail: String? = nil, icon: String? = nil, isOn: Bool, enabled: Bool = true, _ changed: @escaping (Bool) -> Void) -> SettingsRow {
        SettingsRow(title: title, detail: detail, icon: icon, kind: .toggle(isOn: isOn, changed), enabled: enabled)
    }

    static func menu(_ title: String, detail: String? = nil, value: String, icon: String? = nil, enabled: Bool = true, _ menu: UIMenu) -> SettingsRow {
        SettingsRow(title: title, detail: detail, value: value, icon: icon, kind: .menu(menu), enabled: enabled)
    }
}

struct SettingsSection {
    var header: String?
    var footer: String?
    var rows: [SettingsRow]

    init(_ header: String? = nil, footer: String? = nil, rows: [SettingsRow]) {
        self.header = header
        self.footer = footer
        self.rows = rows
    }
}

/// Base of the Ayarlar screens: an inset grouped table of `SettingsSection`s rebuilt from the
/// models (`observeIOS`), pull to refresh, the app's grouped background.
class SettingsTableViewController: UITableViewController {
    /// Strong on purpose: the app model never holds these screens, and a refresh that finishes
    /// after the screen closed must not touch a freed model.
    let app: IOSAppModel
    private(set) var sections: [SettingsSection] = []
    private var observation: IOSObservationToken?

    init(app: IOSAppModel, title: String) {
        self.app = app
        super.init(style: .insetGrouped)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    var store: IOSSettingsStore { app.settingsStore }

    /// Rows per section (tests).
    var rowTitles: [String] { sections.flatMap { $0.rows.map(\.title) } }

    override func viewDidLoad() {
        super.viewDidLoad()
        navigationItem.largeTitleDisplayMode = .never
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "row")
        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            guard let self else { return }
            Task {
                await self.refresh()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        refreshControl = refresh
        observation = observeIOS { [weak self] in self?.rebuild() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        Task { await refresh() }
    }

    /// Subclasses: the sections from the current models (read observable state here).
    func buildSections() -> [SettingsSection] { [] }

    /// Subclasses: reload what the screen shows (pull to refresh, appearing).
    func refresh() async {}

    func rebuild() {
        sections = buildSections()
        tableView.reloadData()
    }

    // MARK: Table

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        sections[section].rows.count
    }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? {
        sections[section].header
    }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        sections[section].footer
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "row", for: indexPath)
        let row = sections[indexPath.section].rows[indexPath.row]
        Self.configure(cell, row)
        return cell
    }

    static func configure(_ cell: UITableViewCell, _ row: SettingsRow) {
        cell.backgroundColor = IOSTheme.elevated
        cell.accessoryView = nil
        cell.accessoryType = .none
        cell.selectionStyle = .none
        var content: UIListContentConfiguration = row.value != nil && row.detail == nil ? .valueCell() : .subtitleCell()
        content.text = row.title
        content.secondaryText = row.detail
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        content.secondaryTextProperties.numberOfLines = 0
        if row.value != nil, row.detail == nil {
            content.secondaryText = row.value
        }
        content.textProperties.color = row.enabled ? IOSTheme.textPrimary : IOSTheme.textTertiary
        if let icon = row.icon {
            content.image = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15))
            content.imageProperties.tintColor = row.tint ?? IOSTheme.textSecondary
            content.imageProperties.reservedLayoutSize = CGSize(width: 26, height: 26)
        }
        switch row.kind {
        case .info:
            if let value = row.value, row.detail != nil { cell.accessoryView = Self.valueLabel(value) }
        case .navigate:
            cell.accessoryType = row.enabled ? .disclosureIndicator : .none
            cell.selectionStyle = row.enabled ? .default : .none
            if let value = row.value, row.detail != nil { cell.accessoryView = Self.valueLabel(value, disclosure: true) }
        case .action(let destructive, _):
            content.textProperties.color = !row.enabled ? IOSTheme.textTertiary : destructive ? .systemRed : IOSTheme.accent
            cell.selectionStyle = row.enabled ? .default : .none
        case .toggle(let isOn, let changed):
            let toggle = UISwitch()
            toggle.isOn = isOn
            toggle.onTintColor = IOSTheme.accent
            toggle.isEnabled = row.enabled
            toggle.accessibilityLabel = row.title
            toggle.addAction(UIAction { [weak toggle] _ in changed(toggle?.isOn ?? false) }, for: .valueChanged)
            cell.accessoryView = toggle
        case .menu(let menu):
            content = .subtitleCell()
            content.text = row.title
            content.secondaryText = row.detail
            content.secondaryTextProperties.color = IOSTheme.textSecondary
            content.secondaryTextProperties.numberOfLines = 0
            content.textProperties.color = row.enabled ? IOSTheme.textPrimary : IOSTheme.textTertiary
            if let icon = row.icon {
                content.image = UIImage(systemName: icon, withConfiguration: UIImage.SymbolConfiguration(pointSize: 15))
                content.imageProperties.tintColor = row.tint ?? IOSTheme.textSecondary
                content.imageProperties.reservedLayoutSize = CGSize(width: 26, height: 26)
            }
            var config = UIButton.Configuration.plain()
            config.title = row.value
            config.image = UIImage(systemName: "chevron.up.chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 11, weight: .semibold))
            config.imagePlacement = .trailing
            config.imagePadding = 4
            config.baseForegroundColor = IOSTheme.textSecondary
            config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 6, bottom: 6, trailing: 0)
            let button = UIButton(configuration: config)
            button.menu = menu
            button.showsMenuAsPrimaryAction = true
            button.isEnabled = row.enabled
            button.accessibilityLabel = row.title
            button.sizeToFit()
            cell.accessoryView = button
        }
        cell.contentConfiguration = content
    }

    private static func valueLabel(_ text: String, disclosure: Bool = false) -> UIView {
        let label = UILabel()
        label.text = text
        label.font = .preferredFont(forTextStyle: .body)
        label.textColor = IOSTheme.textSecondary
        label.sizeToFit()
        guard disclosure else { return label }
        let chevron = UIImageView(image: UIImage(systemName: "chevron.forward", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
        chevron.tintColor = IOSTheme.textTertiary
        let stack = UIStackView(arrangedSubviews: [label, chevron])
        stack.spacing = 6
        stack.alignment = .center
        stack.frame.size = stack.systemLayoutSizeFitting(UIView.layoutFittingCompressedSize)
        return stack
    }

    override func tableView(_ tableView: UITableView, shouldHighlightRowAt indexPath: IndexPath) -> Bool {
        let row = sections[indexPath.section].rows[indexPath.row]
        guard row.enabled else { return false }
        switch row.kind {
        case .navigate, .action: return true
        default: return false
        }
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let row = sections[indexPath.section].rows[indexPath.row]
        guard row.enabled else { return }
        switch row.kind {
        case .navigate(let open): open()
        case .action(_, let run): run()
        default: break
        }
    }

    // MARK: Helpers

    func push(_ controller: UIViewController) {
        navigationController?.pushViewController(controller, animated: true)
    }

    /// A native menu of choices with a check mark on the current one.
    static func choiceMenu<T: Equatable>(_ options: [(T, String)], selected: T?, onPick: @escaping (T) -> Void) -> UIMenu {
        UIMenu(children: options.map { value, label in
            UIAction(title: label, state: value == selected ? .on : .off) { _ in
                Haptics.selection()
                onPick(value)
            }
        })
    }

    /// Run an API call; show its Turkish refusal, a success toast, or nothing.
    func run(_ success: String? = nil, _ work: @escaping () async throws -> Void) {
        Task {
            do {
                try await work()
                if let success {
                    Haptics.success()
                    Toast.show(success, in: view)
                }
            } catch {
                Haptics.error()
                presentError(IOSSettingsStore.describe(error))
            }
        }
    }

    /// Paste or type a secret / a value in a sheet (secure field for secrets).
    func enterText(
        title: String, message: String?, placeholder: String, text: String? = nil, secure: Bool,
        keyboard: UIKeyboardType = .default, save: @escaping (String) async throws -> Void
    ) {
        let controller = SettingsTextEntryViewController(
            title: title, message: message, placeholder: placeholder, text: text, secure: secure, keyboard: keyboard, save: save)
        presentSheet(controller, detents: [.medium(), .large()])
    }
}

/// One text field in a sheet: paste a key (never shown again) or type a value. "Kaydet" waits
/// for the save and shows its refusal in place.
final class SettingsTextEntryViewController: UITableViewController, UITextFieldDelegate {
    private let message: String?
    private let placeholder: String
    private let initialText: String?
    private let secure: Bool
    private let keyboard: UIKeyboardType
    private let save: (String) async throws -> Void
    private let field = UITextField()
    private var errorText: String?
    private var saving = false

    init(title: String, message: String?, placeholder: String, text: String?, secure: Bool, keyboard: UIKeyboardType, save: @escaping (String) async throws -> Void) {
        self.message = message
        self.placeholder = placeholder
        self.initialText = text
        self.secure = secure
        self.keyboard = keyboard
        self.save = save
        super.init(style: .insetGrouped)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "field")
        navigationItem.leftBarButtonItem = UIBarButtonItem(systemItem: .cancel, primaryAction: UIAction { [weak self] _ in
            self?.dismiss(animated: true)
        })
        navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Kaydet", primaryAction: UIAction { [weak self] _ in
            self?.commit()
        })
        navigationItem.rightBarButtonItem?.style = .done
        field.text = initialText
        field.placeholder = placeholder
        field.isSecureTextEntry = secure
        field.keyboardType = keyboard
        field.autocapitalizationType = .none
        field.autocorrectionType = .no
        field.spellCheckingType = .no
        field.textContentType = secure ? .password : nil
        field.clearButtonMode = .whileEditing
        field.returnKeyType = .done
        field.delegate = self
        field.font = .preferredFont(forTextStyle: .body)
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        field.becomeFirstResponder()
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        commit()
        return false
    }

    private func commit() {
        guard !saving else { return }
        let text = (field.text ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        saving = true
        navigationItem.rightBarButtonItem?.isEnabled = false
        Task {
            do {
                try await save(text)
                Haptics.success()
                dismiss(animated: true)
            } catch {
                Haptics.error()
                errorText = IOSSettingsStore.describe(error)
                saving = false
                navigationItem.rightBarButtonItem?.isEnabled = true
                tableView.reloadData()
            }
        }
    }

    override func numberOfSections(in tableView: UITableView) -> Int { 1 }
    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { 1 }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        [errorText, message].compactMap { $0 }.joined(separator: "\n\n")
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "field", for: indexPath)
        cell.backgroundColor = IOSTheme.elevated
        cell.selectionStyle = .none
        if field.superview !== cell.contentView {
            field.removeFromSuperview()
            field.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(field)
            field.pin(to: cell.contentView, insets: UIEdgeInsets(top: 12, left: 16, bottom: 12, right: 16))
        }
        return cell
    }
}
