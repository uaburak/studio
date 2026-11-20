import StudioKit
import UIKit

// "Onay bekleyenler" (docs/URETIM-RESIM.md §11–12): generated pictures waiting for the owner's
// word. The chat shows each as a card with the AI check's report and Onayla / Reddet / Yeniden
// üret; the ⋯ menu opens this list with the same buttons; a row opens its chat message.

/// What the owner decided on a card or a row.
enum ApprovalDecision {
    /// Use a candidate (nil: the first).
    case approve(assetId: EntityID?)
    case reject
    /// "Yeniden üret" or "Etiketi birebir koruyarak yerleştir" (`preserveLabel`).
    case regenerate(preserveLabel: Bool)
}

// MARK: - Decisions (shared by the chat and the list)

extension UIViewController {
    /// Run a decision: rejecting asks for an optional note, generating again asks first (it is
    /// paid, §11) with an optional instruction.
    func decideApproval(_ approval: ApprovalRequest, _ decision: ApprovalDecision, app: IOSAppModel) {
        let model = app.approvals
        let report: (String?) -> Void = { [weak self] problem in
            if let problem {
                self?.presentError(problem)
                Haptics.error()
            }
        }
        switch decision {
        case .approve(let assetId):
            Task {
                let problem = await model.approve(approval, assetId: assetId)
                report(problem)
                if problem == nil {
                    Haptics.success()
                    Toast.show(approval.kind == .productPhotoUpgrade ? "Ürün fotoğrafı değişti" : "Onaylandı; görsel posta yerleşiyor", in: self.view)
                }
            }
        case .reject:
            prompt("Görseller reddedilsin mi?", message: "Görseller kullanılmaz, medyada durur. İstersen nedenini yaz.", text: nil, placeholder: "Not (isteğe bağlı)", action: "Reddet") { note in
                Task {
                    let problem = await model.reject(approval, note: note)
                    report(problem)
                    if problem == nil { Haptics.tap() }
                }
            }
        case .regenerate(let preserveLabel):
            let title = preserveLabel ? "Etiketi birebir koruyarak yerleştir" : "Yeniden üretilsin mi?"
            let message = preserveLabel
                ? "Ürünün gerçek fotoğrafı kesilip yeni sahneye yerleştirilir; etiket hiç değişmez. Her görsel ücretlidir."
                : "Aynı istekle yeni görseller üretilir; her görsel ücretlidir. İstersen ne değişsin yaz."
            prompt(title, message: message, text: nil, placeholder: "ör. daha sıcak ışık (isteğe bağlı)", action: "Üret") { instructions in
                Task {
                    let problem = await model.regenerate(approval, preserveLabel: preserveLabel, instructions: instructions)
                    report(problem)
                    if problem == nil {
                        Haptics.success()
                        Toast.show("Yeniden üretiliyor; yeni görseller sohbete düşecek", in: self.view)
                    }
                }
            }
        }
    }

    /// The candidates full screen; a pending request can be approved from there.
    func showApprovalPictures(_ approval: ApprovalRequest, index: Int, source: UIView?, app: IOSAppModel) {
        guard !approval.assetIds.isEmpty else { return }
        let subject = app.approvals.subject(of: approval)
        let many = approval.assetIds.count > 1
        let items = approval.assetIds.enumerated().map { offset, assetId in
            PhotoViewerItem(assetId: assetId, title: many ? "\(offset + 1). görsel" : approval.kind.label, subtitle: subject ?? approval.kind.label, aspect: 4.0 / 5.0)
        }
        let start = min(max(0, index), items.count - 1)
        let viewer = PhotoViewerViewController(images: app.images, items: items, index: start, sourceFor: { $0 == start ? source : nil }) { [weak self] _ in
            let current = app.approvals.records[approval.id] ?? approval
            guard current.isPending else { return PhotoViewerBar() }
            return PhotoViewerBar(trailing: PhotoViewerAction(label: "Bu görseli onayla", symbol: "checkmark") { viewer, item in
                viewer.close()
                self?.decideApproval(current, .approve(assetId: item.assetId), app: app)
            })
        }
        viewer.open(from: self)
    }
}

// MARK: - The card

@MainActor
enum ApprovalViews {
    /// The chat card (or a placeholder while the request loads).
    static func card(_ approvalId: EntityID, app: IOSAppModel, host: @escaping () -> UIViewController?) -> UIView {
        guard let approval = app.approvals.approval(approvalId) else {
            if app.approvals.isMissing(approvalId) {
                return ChatViews.statusRow(symbol: "questionmark.circle", text: "Onay kaydı okunamadı.")
            }
            return ChatViews.statusRow(spinner: true, text: "Görseller yükleniyor…")
        }
        return card(approval, app: app, host: host)
    }

    static func card(_ approval: ApprovalRequest, app: IOSAppModel, host: @escaping () -> UIViewController?) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 10)
        let busy = app.approvals.busy.contains(approval.id)
        if approval.isPending {
            card.layer.borderColor = IOSTheme.accent.withAlphaComponent(0.6).cgColor
            card.stack.addArrangedSubview(UIStackView.h([
                IOSStatusDotView(color: IOSTheme.accent, size: 7),
                UILabel.studio("Onayın bekleniyor", size: 12, weight: .semibold, color: IOSTheme.accent, style: .caption1),
                UIView.spacer(),
            ], spacing: 6))
        }
        var title = approval.kind.label
        if let subject = app.approvals.subject(of: approval) { title += " · \(subject)" }
        card.stack.addArrangedSubview(UILabel.studio(title, size: 16, weight: .semibold, lines: 0, style: .headline))

        card.stack.addArrangedSubview(pictures(approval, app: app, host: host))
        card.stack.addArrangedSubview(report(approval))

        if approval.isPending {
            let row = actions(approval, busy: busy) { decision in
                guard let host = host() else { return }
                host.decideApproval(approval, decision, app: app)
            }
            card.stack.setCustomSpacing(14, after: card.stack.arrangedSubviews.last!)
            card.stack.addArrangedSubview(row)
        } else {
            card.stack.addArrangedSubview(ChatViews.statusRow(symbol: outcomeSymbol(approval.status), text: approval.outcomeText))
        }
        card.accessibilityElements = nil
        return card
    }

    static func outcomeSymbol(_ status: ApprovalStatus) -> String {
        switch status {
        case .approved: "checkmark"
        case .rejected: "xmark"
        case .superseded: "arrow.triangle.2.circlepath"
        case .pending: "clock"
        case .unknown: "questionmark.circle"
        }
    }

    /// The candidates side by side (4:5); a tap opens the viewer.
    static func pictures(_ approval: ApprovalRequest, app: IOSAppModel, host: @escaping () -> UIViewController?) -> UIView {
        let many = approval.assetIds.count > 1
        let height: CGFloat = many ? 170 : 240
        let width = height * 4 / 5
        var views: [UIView] = []
        for (index, assetId) in approval.assetIds.enumerated() {
            let image = IOSAssetImageView(store: app.images, assetId: assetId, cornerRadius: 14, displayWidth: width * 1.6)
            image.isUserInteractionEnabled = false
            let control = UIControl()
            control.translatesAutoresizingMaskIntoConstraints = false
            control.addSubview(image)
            image.pin(to: control)
            NSLayoutConstraint.activate([
                control.widthAnchor.constraint(equalToConstant: width),
                control.heightAnchor.constraint(equalToConstant: height),
            ])
            let chosen = approval.approvedAssetId == assetId
            if many || chosen {
                let tag = PaddedLabel(text: chosen ? "✓ Kullanıldı" : "\(index + 1)")
                if chosen { tag.backgroundColor = IOSTheme.accent }
                control.addSubview(tag)
                NSLayoutConstraint.activate([
                    tag.leadingAnchor.constraint(equalTo: control.leadingAnchor, constant: 6),
                    tag.bottomAnchor.constraint(equalTo: control.bottomAnchor, constant: -6),
                ])
            }
            if approval.status == .approved && !chosen || approval.status == .rejected || approval.status == .superseded {
                image.alpha = 0.55
            }
            control.addAction(UIAction { [weak image] _ in
                host()?.showApprovalPictures(approval, index: index, source: image, app: app)
            }, for: .touchUpInside)
            control.isAccessibilityElement = true
            control.accessibilityTraits = [.image, .button]
            control.accessibilityLabel = many ? "\(index + 1). görsel\(chosen ? ", kullanıldı" : "")" : approval.kind.label
            control.accessibilityHint = "Büyütür"
            views.append(control)
        }
        let row = UIStackView.h(views, spacing: 8, alignment: .top)
        let scroller = UIScrollView()
        scroller.translatesAutoresizingMaskIntoConstraints = false
        scroller.showsHorizontalScrollIndicator = false
        scroller.clipsToBounds = false
        scroller.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: scroller.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroller.contentLayoutGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: scroller.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroller.contentLayoutGuide.bottomAnchor),
            row.heightAnchor.constraint(equalTo: scroller.frameLayoutGuide.heightAnchor),
            scroller.heightAnchor.constraint(equalToConstant: height),
        ])
        return scroller
    }

    /// The AI check: the summary, then every aspect (✓ or ✗ with what is wrong).
    static func report(_ approval: ApprovalRequest) -> UIView {
        guard let report = approval.checkReport else {
            return ChatViews.statusRow(symbol: "minus.circle", text: "Kontrol yapılmadı.")
        }
        let problems = !report.passed || !report.failed.isEmpty
        let headIcon = ChatViews.icon(problems ? "exclamationmark.triangle.fill" : "checkmark.seal.fill", problems ? IOSTheme.accent : IOSTheme.textSecondary, size: 13)
        let summary = report.summary.trimmingCharacters(in: .whitespacesAndNewlines)
        let headText = summary.isEmpty ? (problems ? "Şu kısımlar hatalı geldi" : "Ürünle karşılaştırıldı; sorun yok") : summary
        let head = UIStackView.h([headIcon, UILabel.studio(headText, size: 14, weight: .medium, lines: 0, style: .subheadline)], spacing: 8, alignment: .top)
        var rows: [UIView] = [head]
        for item in report.items {
            let icon = ChatViews.icon(item.ok ? "checkmark" : "xmark.circle.fill", item.ok ? IOSTheme.textTertiary : IOSTheme.accent, size: 11)
            let text = NSMutableAttributedString(string: item.aspect, attributes: [
                .font: IOSTheme.font(13, item.ok ? .regular : .semibold, style: .footnote),
                .foregroundColor: item.ok ? IOSTheme.textSecondary : IOSTheme.textPrimary,
            ])
            if !item.note.isEmpty {
                text.append(NSAttributedString(string: " · \(item.note)", attributes: [
                    .font: IOSTheme.font(13, style: .footnote), .foregroundColor: IOSTheme.textSecondary,
                ]))
            }
            let label = UILabel.studio("", size: 13, lines: 0, style: .footnote)
            label.attributedText = text
            let row = UIStackView.h([icon, label], spacing: 8, alignment: .top)
            row.isAccessibilityElement = true
            row.accessibilityLabel = "\(item.aspect), \(item.ok ? "doğru" : "hatalı")\(item.note.isEmpty ? "" : ", \(item.note)")"
            rows.append(row)
        }
        let column = UIStackView.v(rows, spacing: 6)
        column.isLayoutMarginsRelativeArrangement = true
        column.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
        column.backgroundColor = IOSTheme.fill
        column.layer.cornerRadius = 12
        column.layer.cornerCurve = .continuous
        return column
    }

    /// Onayla (a menu of candidates when there are several), Reddet, Yeniden üret (a menu with
    /// "Etiketi birebir koruyarak yerleştir").
    static func actions(_ approval: ApprovalRequest, busy: Bool, compact: Bool = false, decide: @escaping (ApprovalDecision) -> Void) -> UIView {
        let approve = UIButton.studioPill(title: "Onayla", kind: .primary, image: compact ? nil : "checkmark") { decide(.approve(assetId: nil)) }
        if approval.assetIds.count > 1 {
            approve.menu = UIMenu(title: "Hangi görsel kullanılsın?", children: approval.assetIds.enumerated().map { index, assetId in
                UIAction(title: "\(index + 1). görseli kullan", image: UIImage(systemName: "\(index + 1).circle")) { _ in decide(.approve(assetId: assetId)) }
            })
            approve.showsMenuAsPrimaryAction = true
        }
        approve.configuration?.showsActivityIndicator = busy
        approve.accessibilityHint = "Görseli kullanır"
        let reject = UIButton.studioPill(title: "Reddet", kind: .secondary) { decide(.reject) }
        let regenerate = UIButton.studioPill(title: "Yeniden üret", kind: .secondary, image: compact ? nil : "arrow.triangle.2.circlepath") { decide(.regenerate(preserveLabel: false)) }
        regenerate.menu = UIMenu(children: [
            UIAction(title: "Yeniden üret", subtitle: "Aynı istekle yeni görseller", image: UIImage(systemName: "arrow.triangle.2.circlepath")) { _ in
                decide(.regenerate(preserveLabel: false))
            },
            UIAction(title: "Etiketi birebir koruyarak yerleştir", subtitle: "Gerçek ürün fotoğrafı sahneye yerleşir", image: UIImage(systemName: "tag")) { _ in
                decide(.regenerate(preserveLabel: true))
            },
        ])
        regenerate.showsMenuAsPrimaryAction = true
        regenerate.accessibilityHint = approval.canRegenerate ? "Ücretli; önce sorar" : "Bu kayıt için yeniden üretim yapılamıyor"
        for button in [approve, reject, regenerate] {
            button.isEnabled = !busy
            if compact { button.configuration?.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12) }
        }
        regenerate.isEnabled = !busy && approval.canRegenerate
        return UIStackView.h([approve, reject, regenerate, UIView.spacer()], spacing: 8)
    }
}

// MARK: - The list

/// "Onay bekleyenler": the current brand's pending requests (or one post's), newest first.
/// Each row: the first candidate, what it is for, the check in one line and the three buttons;
/// swipe for the same, tap to open the chat message it came with.
final class IOSApprovalsViewController: UIViewController, UITableViewDelegate {
    private unowned let app: IOSAppModel
    /// Only this post's requests (opened from a post); nil = the whole brand.
    let contentId: EntityID?
    private let tableView = UITableView(frame: .zero, style: .plain)
    private var dataSource: UITableViewDiffableDataSource<Int, EntityID>!
    private let emptyView = EmptyStateView()
    private var observation: IOSObservationToken?
    private var signatures: [EntityID: Int] = [:]
    private var lastBrandId: EntityID?

    init(app: IOSAppModel, contentId: EntityID? = nil) {
        self.app = app
        self.contentId = contentId
        super.init(nibName: nil, bundle: nil)
        title = "Onay bekleyenler"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var items: [ApprovalRequest] {
        let pending = app.approvals.pending
        guard let contentId else { return pending }
        return pending.filter { $0.contentId == contentId }
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = .clear
        tableView.delegate = self
        tableView.separatorInset = UIEdgeInsets(top: 0, left: IOSTheme.gutter + 76 + 12, bottom: 0, right: 0)
        tableView.rowHeight = UITableView.automaticDimension
        tableView.estimatedRowHeight = 140
        tableView.register(ApprovalRowCell.self, forCellReuseIdentifier: ApprovalRowCell.reuseId)
        tableView.topEdgeEffect.style = .soft
        setContentScrollView(tableView, for: .top)
        view.addSubview(tableView)
        tableView.pin(to: view)

        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] table, indexPath, id in
            let cell = table.dequeueReusableCell(withIdentifier: ApprovalRowCell.reuseId, for: indexPath) as! ApprovalRowCell
            if let self, let approval = self.app.approvals.records[id] { self.configure(cell, approval) }
            return cell
        }
        dataSource.defaultRowAnimation = .fade

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task {
                await self?.app.approvals.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        tableView.refreshControl = refresh

        emptyView.isHidden = true
        view.addSubview(emptyView)
        NSLayoutConstraint.activate([
            emptyView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            emptyView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            emptyView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            emptyView.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
        ])

        observation = observeIOS { [weak self] in self?.render() }
        Task { await app.approvals.load() }
    }

    private func configure(_ cell: ApprovalRowCell, _ approval: ApprovalRequest) {
        cell.configure(
            approval, subject: app.approvals.subject(of: approval), images: app.images, busy: app.approvals.busy.contains(approval.id),
            onPicture: { [weak self] source in
                guard let self else { return }
                self.showApprovalPictures(approval, index: 0, source: source, app: self.app)
            },
            decide: { [weak self] decision in
                guard let self else { return }
                self.decideApproval(approval, decision, app: self.app)
            })
    }

    private func render() {
        if app.currentBrandId != lastBrandId {
            if lastBrandId != nil { Task { await app.approvals.load() } }
            lastBrandId = app.currentBrandId
        }
        let items = self.items
        var next: [EntityID: Int] = [:]
        for approval in items {
            var hasher = Hasher()
            hasher.combine(approval)
            hasher.combine(app.approvals.busy.contains(approval.id))
            hasher.combine(app.approvals.subject(of: approval))
            next[approval.id] = hasher.finalize()
        }
        let changed = items.map(\.id).filter { signatures[$0] != nil && signatures[$0] != next[$0] }
        signatures = next
        var snapshot = NSDiffableDataSourceSnapshot<Int, EntityID>()
        snapshot.appendSections([0])
        snapshot.appendItems(items.map(\.id))
        snapshot.reconfigureItems(changed)
        dataSource.apply(snapshot, animatingDifferences: view.window != nil)

        let loading = app.approvals.isLoading && !app.approvals.hasLoaded
        if items.isEmpty && !loading {
            emptyView.isHidden = false
            if let error = app.approvals.error {
                emptyView.configure(icon: "exclamationmark.triangle", title: "Onay bekleyenler okunamadı", message: error, actions: [
                    UIButton.studioPill(title: "Yeniden dene", kind: .secondary) { [weak self] in Task { await self?.app.approvals.load() } },
                ])
            } else {
                emptyView.configure(
                    icon: "checkmark.seal", title: "Onay bekleyen yok",
                    message: contentId == nil
                        ? "Sohbette üretilen görseller burada onayını bekler. Onayla, reddet ya da yeniden ürettir."
                        : "Bu postun onay bekleyen görseli yok.")
            }
        } else {
            emptyView.isHidden = true
        }
    }

    // MARK: UITableViewDelegate

    func tableView(_ tableView: UITableView, didSelectRowAt indexPath: IndexPath) {
        tableView.deselectRow(at: indexPath, animated: true)
        guard let id = dataSource.itemIdentifier(for: indexPath), let approval = app.approvals.records[id] else { return }
        open(approval, source: tableView.cellForRow(at: indexPath))
    }

    /// The chat message it came with; else its post; else the pictures.
    private func open(_ approval: ApprovalRequest, source: UIView?) {
        if let conversationId = approval.conversationId, let messageId = approval.messageId {
            app.open(.conversationMessage(conversationId, messageId: messageId))
        } else if let contentId = approval.contentId {
            app.open(.post(contentId))
        } else {
            showApprovalPictures(approval, index: 0, source: (source as? ApprovalRowCell)?.thumbnail, app: app)
        }
    }

    func tableView(_ tableView: UITableView, trailingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath), let approval = app.approvals.records[id], approval.isPending else { return nil }
        let approve = UIContextualAction(style: .normal, title: "Onayla") { [weak self] _, _, done in
            guard let self else { return done(false) }
            self.decideApproval(approval, .approve(assetId: nil), app: self.app)
            done(true)
        }
        approve.backgroundColor = IOSTheme.accent
        approve.image = UIImage(systemName: "checkmark")
        let reject = UIContextualAction(style: .destructive, title: "Reddet") { [weak self] _, _, done in
            guard let self else { return done(false) }
            self.decideApproval(approval, .reject, app: self.app)
            done(true)
        }
        reject.image = UIImage(systemName: "xmark")
        let configuration = UISwipeActionsConfiguration(actions: [approve, reject])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    func tableView(_ tableView: UITableView, leadingSwipeActionsConfigurationForRowAt indexPath: IndexPath) -> UISwipeActionsConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath), let approval = app.approvals.records[id], approval.isPending, approval.canRegenerate else { return nil }
        let regenerate = UIContextualAction(style: .normal, title: "Yeniden üret") { [weak self] _, _, done in
            guard let self else { return done(false) }
            self.decideApproval(approval, .regenerate(preserveLabel: false), app: self.app)
            done(true)
        }
        regenerate.backgroundColor = IOSTheme.ink
        regenerate.image = UIImage(systemName: "arrow.triangle.2.circlepath")
        let configuration = UISwipeActionsConfiguration(actions: [regenerate])
        configuration.performsFirstActionWithFullSwipe = false
        return configuration
    }

    func tableView(_ tableView: UITableView, contextMenuConfigurationForRowAt indexPath: IndexPath, point: CGPoint) -> UIContextMenuConfiguration? {
        guard let id = dataSource.itemIdentifier(for: indexPath), let approval = app.approvals.records[id] else { return nil }
        return UIContextMenuConfiguration(identifier: nil, previewProvider: nil) { [weak self] _ in
            guard let self else { return nil }
            let decide: (ApprovalDecision) -> Void = { [weak self] decision in
                guard let self else { return }
                self.decideApproval(approval, decision, app: self.app)
            }
            var open: [UIMenuElement] = []
            if approval.conversationId != nil {
                open.append(UIAction(title: "Sohbette aç", image: UIImage(systemName: "bubble.left")) { [weak self] _ in self?.open(approval, source: nil) })
            }
            if let contentId = approval.contentId {
                open.append(UIAction(title: "Postu aç", image: UIImage(systemName: "square.grid.2x2")) { [weak self] _ in self?.app.open(.post(contentId)) })
            }
            let decisions: [UIMenuElement] = approval.isPending ? [
                UIAction(title: "Onayla", image: UIImage(systemName: "checkmark")) { _ in decide(.approve(assetId: nil)) },
                UIAction(title: "Reddet", image: UIImage(systemName: "xmark"), attributes: .destructive) { _ in decide(.reject) },
                UIAction(title: "Yeniden üret", image: UIImage(systemName: "arrow.triangle.2.circlepath"), attributes: approval.canRegenerate ? [] : .disabled) { _ in decide(.regenerate(preserveLabel: false)) },
                UIAction(title: "Etiketi birebir koruyarak yerleştir", image: UIImage(systemName: "tag"), attributes: approval.canRegenerate ? [] : .disabled) { _ in decide(.regenerate(preserveLabel: true)) },
            ] : []
            return UIMenu(children: [UIMenu(options: .displayInline, children: open), UIMenu(options: .displayInline, children: decisions)])
        }
    }
}

/// One pending request: the first picture (with "+1" for more), kind and subject, the check in
/// one line, when it came, and the buttons.
final class ApprovalRowCell: UITableViewCell {
    static let reuseId = "approval"
    let thumbnail = IOSAssetImageView(store: nil, cornerRadius: 12, displayWidth: 160)
    private let thumbButton = UIControl()
    private let countLabel = PaddedLabel(text: "")
    private let titleLabel = UILabel.studio("", size: 16, weight: .semibold, lines: 2, style: .headline)
    private let subjectLabel = UILabel.studio("", size: 14, color: IOSTheme.textSecondary, lines: 1, style: .subheadline)
    private let checkIcon = UIImageView()
    private let checkLabel = UILabel.studio("", size: 13, lines: 2, style: .footnote)
    private let actionsHolder = UIStackView()
    private var onPicture: ((UIView) -> Void)?

    override init(style: UITableViewCell.CellStyle, reuseIdentifier: String?) {
        super.init(style: style, reuseIdentifier: reuseIdentifier)
        backgroundColor = .clear
        thumbButton.translatesAutoresizingMaskIntoConstraints = false
        thumbButton.addSubview(thumbnail)
        thumbnail.pin(to: thumbButton)
        thumbnail.isUserInteractionEnabled = false
        thumbButton.addSubview(countLabel)
        NSLayoutConstraint.activate([
            thumbButton.widthAnchor.constraint(equalToConstant: 76),
            thumbButton.heightAnchor.constraint(equalToConstant: 95),
            countLabel.trailingAnchor.constraint(equalTo: thumbButton.trailingAnchor, constant: -4),
            countLabel.bottomAnchor.constraint(equalTo: thumbButton.bottomAnchor, constant: -4),
        ])
        thumbButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.onPicture?(self.thumbnail)
        }, for: .touchUpInside)
        thumbButton.isAccessibilityElement = true
        thumbButton.accessibilityTraits = [.image, .button]
        thumbButton.accessibilityLabel = "Görseller"
        thumbButton.accessibilityHint = "Büyütür"

        checkIcon.translatesAutoresizingMaskIntoConstraints = false
        checkIcon.contentMode = .center
        checkIcon.setContentHuggingPriority(.required, for: .horizontal)
        checkIcon.widthAnchor.constraint(equalToConstant: 16).isActive = true
        let checkRow = UIStackView.h([checkIcon, checkLabel], spacing: 6, alignment: .top)
        actionsHolder.axis = .vertical
        let texts = UIStackView.v([titleLabel, subjectLabel, checkRow, actionsHolder], spacing: 4)
        texts.setCustomSpacing(10, after: checkRow)
        let row = UIStackView.h([thumbButton, texts], spacing: 12, alignment: .top)
        contentView.addSubview(row)
        row.pin(to: contentView, insets: UIEdgeInsets(top: 14, left: IOSTheme.gutter, bottom: 14, right: IOSTheme.gutter))
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    func configure(_ approval: ApprovalRequest, subject: String?, images: IOSImageStore, busy: Bool, onPicture: @escaping (UIView) -> Void, decide: @escaping (ApprovalDecision) -> Void) {
        self.onPicture = onPicture
        thumbnail.store = images
        thumbnail.assetId = approval.coverAssetId
        countLabel.text = "+\(approval.assetIds.count - 1)"
        countLabel.isHidden = approval.assetIds.count < 2
        titleLabel.text = approval.kind.label
        let when = AssistantStatus.relative(approval.createdAt)
        subjectLabel.text = [subject, when].compactMap { $0 }.joined(separator: " · ")
        let problems = approval.hasProblems
        checkIcon.image = UIImage(systemName: approval.checkReport == nil ? "minus.circle" : (problems ? "exclamationmark.triangle.fill" : "checkmark.seal.fill"),
                                  withConfiguration: UIImage.SymbolConfiguration(pointSize: 12, weight: .semibold))
        checkIcon.tintColor = problems ? IOSTheme.accent : IOSTheme.textSecondary
        checkLabel.text = approval.checkLine
        checkLabel.textColor = problems ? IOSTheme.textPrimary : IOSTheme.textSecondary
        actionsHolder.removeAllArranged()
        actionsHolder.addArrangedSubview(ApprovalViews.actions(approval, busy: busy, compact: true, decide: decide))
        accessibilityHint = approval.conversationId != nil ? "Sohbetteki mesajı açar" : nil
    }
}
