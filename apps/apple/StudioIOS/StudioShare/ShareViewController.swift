import StudioKit
import UIKit

/// The share sheet's entry (`NSExtensionPrincipalClass`): "Studio'ya gönder".
final class ShareViewController: UIViewController {
    private var model: ShareModel?

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .systemGroupedBackground
        let model = ShareModel()
        self.model = model
        let form = ShareFormViewController(model: model) { [weak self] outcome in self?.finish(outcome) }
        let nav = UINavigationController(rootViewController: form)
        addChild(nav)
        nav.view.frame = view.bounds
        nav.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(nav.view)
        nav.didMove(toParent: self)
        model.start(with: extensionContext)
    }

    enum Outcome { case cancelled, finished }

    private func finish(_ outcome: Outcome) {
        switch outcome {
        case .cancelled:
            extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        case .finished:
            extensionContext?.completeRequest(returningItems: nil)
        }
    }
}

/// One plain form: what is shared, the brand, where it goes, then "Gönder".
final class ShareFormViewController: UITableViewController, UITextViewDelegate {
    private enum Row: Hashable {
        case items
        case connection
        case brand
        case destination(ShareModel.Destination)
        case conversation
        case message
        case slot
        case status
    }

    private let model: ShareModel
    private let onFinish: (ShareViewController.Outcome) -> Void
    private var sections: [(title: String?, footer: String?, rows: [Row])] = []
    private let messageView = UITextView()
    private lazy var sendItem = UIBarButtonItem(title: "Gönder", style: .prominent, target: self, action: #selector(sendTapped))

    init(model: ShareModel, onFinish: @escaping (ShareViewController.Outcome) -> Void) {
        self.model = model
        self.onFinish = onFinish
        super.init(style: .insetGrouped)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        title = "Studio'ya gönder"
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", style: .plain, target: self, action: #selector(cancelTapped))
        navigationItem.rightBarButtonItem = sendItem
        tableView.register(UITableViewCell.self, forCellReuseIdentifier: "cell")
        tableView.keyboardDismissMode = .interactive
        messageView.font = .preferredFont(forTextStyle: .body)
        messageView.backgroundColor = .clear
        messageView.isScrollEnabled = false
        messageView.delegate = self
        messageView.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        messageView.accessibilityLabel = "Mesaj"
        model.onChange = { [weak self] in self?.render() }
        render()
    }

    // MARK: Rendering

    private func render() {
        var next: [(String?, String?, [Row])] = []
        next.append((nil, model.isLoadingItems ? "Dosyalar okunuyor…" : itemsFooter, [.items]))
        next.append((nil, nil, [.connection]))
        if model.isConnected || !model.brands.isEmpty {
            next.append(("Marka", nil, [.brand]))
            var destinations: [Row] = [.destination(.media), .destination(.chat)]
            if model.canUseSlot || model.destination == .slot { destinations.append(.destination(.slot)) }
            next.append(("Nereye", destinationFooter, destinations))
            switch model.destination {
            case .media: break
            case .chat: next.append(("Sohbet", "Mesaj yazmazsan dosyalar yalnızca sohbete eklenir; Studio yine de cevap verir.", [.conversation, .message]))
            case .slot: next.append(("Post", nil, [.slot]))
            }
        }
        if case .editing = model.phase {} else { next.append((nil, nil, [.status])) }
        sections = next.map { (title: $0.0, footer: $0.1, rows: $0.2) }
        tableView.reloadData()

        sendItem.isEnabled = model.canSend
        switch model.phase {
        case .working:
            navigationItem.leftBarButtonItem = model.canContinueInBackground
                ? UIBarButtonItem(title: "Arka planda sürsün", style: .plain, target: self, action: #selector(leaveTapped))
                : nil
        case .done:
            navigationItem.leftBarButtonItem = nil
            navigationItem.rightBarButtonItem = UIBarButtonItem(title: "Kapat", style: .prominent, target: self, action: #selector(leaveTapped))
        case .editing, .failed:
            navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", style: .plain, target: self, action: #selector(cancelTapped))
            navigationItem.rightBarButtonItem = sendItem
        }
    }

    private var itemsFooter: String? {
        let images = model.imageCount
        let videos = model.videoCount
        var parts: [String] = []
        if images > 0 { parts.append(images == 1 ? "1 fotoğraf" : "\(images) fotoğraf") }
        if videos > 0 { parts.append(videos == 1 ? "1 video" : "\(videos) video") }
        let errors = model.items.compactMap(\.error)
        var text = parts.isEmpty ? "" : parts.joined(separator: ", ")
        if let first = errors.first { text += (text.isEmpty ? "" : "\n") + first }
        if videos > 0 { text += (text.isEmpty ? "" : "\n") + "50 MB'tan büyük videolar gönderilmeden önce küçültülür." }
        return text.isEmpty ? nil : text
    }

    private var destinationFooter: String? {
        switch model.destination {
        case .media: "Markanın medyasına yüklenir; Mac'te ve telefonda Medya'da görünür."
        case .chat: nil
        case .slot: model.canUseSlot ? "Fotoğraf postun boş görsel yuvasına konur; Mac yeni bir sürüm hazırlar." : "Görsel yuvasına tek bir fotoğraf konur."
        }
    }

    override func numberOfSections(in tableView: UITableView) -> Int { sections.count }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { sections[section].rows.count }

    override func tableView(_ tableView: UITableView, titleForHeaderInSection section: Int) -> String? { sections[section].title }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? { sections[section].footer }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let row = sections[indexPath.section].rows[indexPath.row]
        let cell = UITableViewCell(style: .value1, reuseIdentifier: nil)
        var content = UIListContentConfiguration.valueCell()
        cell.accessoryType = .none
        cell.selectionStyle = .default
        switch row {
        case .items:
            cell.selectionStyle = .none
            cell.contentView.addSubview(thumbnailStrip())
            return cell
        case .connection:
            cell.selectionStyle = .none
            switch model.connection {
            case .connecting:
                content.text = "Mac'e bağlanıyor…"
                content.image = UIImage(systemName: "laptopcomputer")
            case .connected(let name):
                content.text = name
                content.secondaryText = "Bağlı"
                content.image = UIImage(systemName: "laptopcomputer")
            case .failed(let reason):
                content = UIListContentConfiguration.subtitleCell()
                content.text = "Mac'e ulaşılamıyor"
                content.secondaryText = reason + " Dokun: yeniden dene."
                content.secondaryTextProperties.color = .secondaryLabel
                content.image = UIImage(systemName: "exclamationmark.triangle")
                content.imageProperties.tintColor = .systemOrange
                cell.selectionStyle = .default
            }
        case .brand:
            content.text = model.brandName ?? "Marka seç"
            cell.accessoryType = .disclosureIndicator
        case .destination(let destination):
            content.text = switch destination {
            case .media: "Medya'ya yükle"
            case .chat: "Sohbete gönder"
            case .slot: "Postun görsel yuvasına koy"
            }
            let symbol = switch destination {
            case .media: "photo.on.rectangle"
            case .chat: "bubble.left.and.text.bubble.right"
            case .slot: "rectangle.dashed"
            }
            content.image = UIImage(systemName: symbol)
            cell.accessoryType = model.destination == destination ? .checkmark : .none
            if destination == .slot, !model.canUseSlot {
                content.textProperties.color = .secondaryLabel
            }
        case .conversation:
            content.text = "Sohbet"
            content.secondaryText = model.conversationId.flatMap { id in model.conversations.first { $0.id == id }?.title } ?? "Yeni sohbet"
            cell.accessoryType = .disclosureIndicator
        case .message:
            cell.selectionStyle = .none
            messageView.text = model.message
            messageView.translatesAutoresizingMaskIntoConstraints = false
            cell.contentView.addSubview(messageView)
            NSLayoutConstraint.activate([
                messageView.leadingAnchor.constraint(equalTo: cell.contentView.layoutMarginsGuide.leadingAnchor),
                messageView.trailingAnchor.constraint(equalTo: cell.contentView.layoutMarginsGuide.trailingAnchor),
                messageView.topAnchor.constraint(equalTo: cell.contentView.topAnchor),
                messageView.bottomAnchor.constraint(equalTo: cell.contentView.bottomAnchor),
                messageView.heightAnchor.constraint(greaterThanOrEqualToConstant: 88),
            ])
            if model.message.isEmpty { messageView.text = "" }
            return cell
        case .slot:
            content = UIListContentConfiguration.subtitleCell()
            if let target = model.slotTarget {
                content.text = target.title
                content.secondaryText = target.slotLabel
            } else {
                content.text = model.isLoadingOptions ? "Postlar okunuyor…" : "Post ve görsel yuvası seç"
            }
            cell.accessoryType = .disclosureIndicator
        case .status:
            cell.selectionStyle = .none
            content = UIListContentConfiguration.subtitleCell()
            switch model.phase {
            case .working(let label, let progress):
                content.text = progress.map { "\(label) · %\(Int(($0 * 100).rounded()))" } ?? "\(label)…"
                content.secondaryText = model.usesBackgroundUploads
                    ? (model.canContinueInBackground ? "Ekranı kapatabilirsin; yükleme arka planda sürer." : nil)
                    : "Gönderilirken bu ekranı açık tut."
                content.image = UIImage(systemName: "arrow.up.circle")
            case .done(let text):
                content.text = "Gönderildi"
                content.secondaryText = text
                content.image = UIImage(systemName: "checkmark.circle.fill")
                content.imageProperties.tintColor = .systemGreen
            case .failed(let text):
                content.text = "Gönderilemedi"
                content.secondaryText = text
                content.image = UIImage(systemName: "xmark.octagon")
                content.imageProperties.tintColor = .systemRed
            case .editing:
                break
            }
        }
        cell.contentConfiguration = content
        return cell
    }

    private func thumbnailStrip() -> UIView {
        let scroll = UIScrollView(frame: CGRect(x: 0, y: 0, width: tableView.bounds.width - 32, height: 96))
        scroll.showsHorizontalScrollIndicator = false
        scroll.autoresizingMask = [.flexibleWidth]
        let stack = UIStackView()
        stack.axis = .horizontal
        stack.spacing = 8
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 12),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -12),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 10),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -10),
            stack.heightAnchor.constraint(equalToConstant: 76),
        ])
        for item in model.items {
            let image = UIImageView(image: item.thumbnail ?? UIImage(systemName: item.kind == .video ? "video" : "photo"))
            image.contentMode = item.thumbnail == nil ? .center : .scaleAspectFill
            image.tintColor = .secondaryLabel
            image.backgroundColor = .tertiarySystemFill
            image.clipsToBounds = true
            image.layer.cornerRadius = 8
            image.layer.cornerCurve = .continuous
            image.alpha = item.error == nil ? 1 : 0.4
            image.translatesAutoresizingMaskIntoConstraints = false
            image.widthAnchor.constraint(equalToConstant: 76).isActive = true
            image.isAccessibilityElement = true
            image.accessibilityLabel = item.kind == .video ? "Video" : "Fotoğraf"
            if item.kind == .video {
                let badge = UILabel()
                badge.text = item.durationMs.map { Self.duration($0) } ?? "Video"
                badge.font = .systemFont(ofSize: 11, weight: .semibold)
                badge.textColor = .white
                badge.backgroundColor = UIColor.black.withAlphaComponent(0.55)
                badge.layer.cornerRadius = 4
                badge.clipsToBounds = true
                badge.textAlignment = .center
                badge.translatesAutoresizingMaskIntoConstraints = false
                image.addSubview(badge)
                NSLayoutConstraint.activate([
                    badge.trailingAnchor.constraint(equalTo: image.trailingAnchor, constant: -4),
                    badge.bottomAnchor.constraint(equalTo: image.bottomAnchor, constant: -4),
                    badge.heightAnchor.constraint(equalToConstant: 16),
                    badge.widthAnchor.constraint(greaterThanOrEqualToConstant: 34),
                ])
            }
            stack.addArrangedSubview(image)
        }
        if model.items.isEmpty {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            stack.addArrangedSubview(spinner)
        }
        return scroll
    }

    static func duration(_ ms: Int) -> String {
        let seconds = max(0, ms / 1000)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    override func tableView(_ tableView: UITableView, heightForRowAt indexPath: IndexPath) -> CGFloat {
        sections[indexPath.section].rows[indexPath.row] == .items ? 96 : UITableView.automaticDimension
    }

    // MARK: Actions

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard !model.isWorking else { return }
        switch sections[indexPath.section].rows[indexPath.row] {
        case .connection:
            model.retryConnection()
        case .brand:
            let picker = SharePickerViewController(title: "Marka", options: model.brands.map { ($0.id, $0.name, nil) }, selected: model.brandId) { [weak self] id in
                self?.model.brandId = id
            }
            navigationController?.pushViewController(picker, animated: true)
        case .destination(let destination):
            if destination == .slot, !model.canUseSlot { return }
            model.destination = destination
            render()
        case .conversation:
            let options = [("", "Yeni sohbet", nil as String?)] + model.conversations.map { ($0.id, $0.title, nil as String?) }
            let picker = SharePickerViewController(title: "Sohbet", options: options, selected: model.conversationId ?? "", loading: model.isLoadingOptions) { [weak self] id in
                self?.model.conversationId = id.isEmpty ? nil : id
            }
            navigationController?.pushViewController(picker, animated: true)
        case .slot:
            let options = model.slotTargets.map { ($0.id, $0.title, Optional($0.slotLabel)) }
            let picker = SharePickerViewController(
                title: "Görsel yuvası", options: options, selected: model.slotTarget?.id, loading: model.isLoadingOptions,
                empty: "Bu markada boş görsel yuvası olan post yok."
            ) { [weak self] id in
                guard let self else { return }
                self.model.slotTarget = self.model.slotTargets.first { $0.id == id }
            }
            navigationController?.pushViewController(picker, animated: true)
        case .items, .message, .status:
            break
        }
    }

    func textViewDidChange(_ textView: UITextView) {
        model.message = textView.text
        // Grow the cell with the text.
        UIView.performWithoutAnimation {
            tableView.beginUpdates()
            tableView.endUpdates()
        }
    }

    @objc private func sendTapped() {
        view.endEditing(true)
        Task { await model.send() }
    }

    @objc private func cancelTapped() {
        onFinish(.cancelled)
    }

    @objc private func leaveTapped() {
        onFinish(.finished)
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        render()
    }
}

/// A plain list with one checkmark (brands, conversations, slots).
final class SharePickerViewController: UITableViewController {
    private let options: [(id: String, title: String, subtitle: String?)]
    private let selected: String?
    private let loading: Bool
    private let empty: String?
    private let onPick: (String) -> Void

    init(title: String, options: [(String, String, String?)], selected: String?, loading: Bool = false, empty: String? = nil, onPick: @escaping (String) -> Void) {
        self.options = options.map { (id: $0.0, title: $0.1, subtitle: $0.2) }
        self.selected = selected
        self.loading = loading
        self.empty = empty
        self.onPick = onPick
        super.init(style: .insetGrouped)
        self.title = title
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func tableView(_ tableView: UITableView, numberOfRowsInSection section: Int) -> Int { options.count }

    override func tableView(_ tableView: UITableView, titleForFooterInSection section: Int) -> String? {
        if loading { return "Okunuyor…" }
        return options.isEmpty ? empty : nil
    }

    override func tableView(_ tableView: UITableView, cellForRowAt indexPath: IndexPath) -> UITableViewCell {
        let option = options[indexPath.row]
        let cell = UITableViewCell(style: .subtitle, reuseIdentifier: nil)
        var content = UIListContentConfiguration.subtitleCell()
        content.text = option.title
        content.secondaryText = option.subtitle
        content.secondaryTextProperties.color = .secondaryLabel
        cell.contentConfiguration = content
        cell.accessoryType = option.id == selected ? .checkmark : .none
        return cell
    }

    override func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        onPick(options[indexPath.row].id)
        navigationController?.popViewController(animated: true)
    }
}
