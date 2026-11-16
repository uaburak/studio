import StudioKit
import UIKit

/// Sohbet listesi (`UITableViewController`) — active conversations for the selected brand + "+ Yeni Sohbet".
final class ChatListViewController: UIViewController, UITableViewDataSource, UITableViewDelegate {
    private unowned let app: IOSAppModel
    private let tableView = UITableView(frame: .zero, style: .insetGrouped)
    private let emptyLabel = UILabel.studio(
        "Henüz sohbet yok. Sağ üstteki + ile yeni sohbet başlatabilirsin.",
        size: 14,
        color: IOSTheme.textSecondary,
        lines: 2
    )
    private var navToken: IOSObservationToken?
    private var observation: IOSObservationToken?
    private var visibleConversations: [Conversation] = []

    init(app: IOSAppModel) {
        self.app = app
        super.init(nibName: nil, bundle: nil)
        title = "Sohbet"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground

        let newChatItem = UIBarButtonItem(
            image: UIImage(systemName: "square.and.pencil"),
            primaryAction: UIAction { [weak self] _ in
                self?.startNewConversation()
            }
        )
        newChatItem.accessibilityLabel = "Yeni Sohbet"
        navigationItem.rightBarButtonItem = newChatItem
        navToken = StudioNavBarItems.install(on: self, app: app)

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = IOSTheme.groupedBackground
        tableView.dataSource = self
        tableView.delegate = self
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "conv")
        view.addSubview(tableView)

        emptyLabel.textAlignment = .center
        view.addSubview(emptyLabel)

        NSLayoutConstraint.activate([
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            emptyLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 32),
            emptyLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -32),
            emptyLabel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
        ])

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            Task {
                await self.app.load()
                refresh.endRefreshing()
            }
        }, for: .valueChanged)
        tableView.refreshControl = refresh

        observation = observeIOS { [weak self] in
            self?.reloadList()
        }
    }

    private func reloadList() {
        let brandId = app.currentBrandId
        visibleConversations = app.conversations.filter { brandId == nil || $0.brandId == brandId || $0.brandId == nil }
        emptyLabel.isHidden = !visibleConversations.isEmpty
        tableView.reloadData()
    }

    private func startNewConversation() {
        Task {
            do {
                let conv = try await app.createAndOpenConversation()
                openConversation(conv.id)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
        }
    }

    func openConversation(_ id: EntityID) {
        let vc = IOSChatViewController(model: app.conversationModel(id))
        vc.hidesBottomBarWhenPushed = true
        navigationController?.pushViewController(vc, animated: true)
    }

    private func presentError(_ message: String) {
        let alert = UIAlertController(title: "Hata", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "Tamam", style: .default))
        present(alert, animated: true)
    }

    // MARK: - UITableViewDataSource / Delegate

    func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int {
        visibleConversations.count
    }

    func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let cell = tableView.dequeueReusableCell(withIdentifier: "conv", for: indexPath)
        let conv = visibleConversations[indexPath.row]
        var content = UIListContentConfiguration.subtitleCell()
        content.text = conv.displayTitle
        content.textProperties.font = UIFont.systemFont(ofSize: 15, weight: .medium)
        content.textProperties.color = IOSTheme.textPrimary
        content.secondaryText = TurkishFormat.dayAndTime(conv.lastActivityAt)
        content.secondaryTextProperties.color = IOSTheme.textSecondary
        if conv.activeRunId != nil {
            content.image = UIImage(systemName: "circle.fill")
            content.imageProperties.tintColor = IOSTheme.accent
        } else {
            content.image = UIImage(systemName: "bubble.left")
            content.imageProperties.tintColor = IOSTheme.textSecondary
        }
        cell.contentConfiguration = content
        cell.accessoryType = .disclosureIndicator
        return cell
    }

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        let conv = visibleConversations[indexPath.row]
        openConversation(conv.id)
    }

    func tableView(
        _ tableView: UITableView,
        trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath
    ) -> UISwipeActionsConfiguration? {
        let conv = visibleConversations[indexPath.row]
        let archive = UIContextualAction(style: .destructive, title: "Arşivle") { [weak self] _, _, done in
            guard let self else { done(false); return }
            Task {
                _ = try? await self.app.conversationService.archiveConversation(conv.id)
                self.app.conversations.removeAll { $0.id == conv.id }
                done(true)
            }
        }
        return UISwipeActionsConfiguration(actions: [archive])
    }
}
