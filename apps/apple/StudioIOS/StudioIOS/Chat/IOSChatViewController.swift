import StudioKit
import UIKit

/// The app's root screen: one conversation (or the empty home of a new chat), full screen
/// like the Claude app. Top: the drawer button (left) and, on the right, new chat + "…"
/// (a brand / model button on the home). Messages scroll under the bars with a soft edge;
/// the composer floats at the bottom.
final class IOSChatViewController: UIViewController, UITableViewDelegate {
    let model: IOSConversationModel
    /// Opens the drawer (set by the root).
    var onOpenDrawer: (() -> Void)?

    private let tableView = UITableView(frame: .zero, style: .plain)
    private(set) lazy var composer = ChatComposerView(model: model)
    let home = ChatHomeView()
    let scrollButton = UIButton.glassCircle("arrow.down", label: "En alta git", side: 44, pointSize: 16)
    private let statusChip = UILabel.studio("", size: 13, weight: .medium, color: IOSTheme.textSecondary, style: .footnote)
    private(set) var drawerItem: UIBarButtonItem!
    private(set) var newChatItem: UIBarButtonItem!
    private(set) var moreItem: UIBarButtonItem!
    private(set) var brandItem: UIBarButtonItem!
    private var dataSource: UITableViewDiffableDataSource<Int, String>!
    private var observation: IOSObservationToken?
    private var badgeObservation: IOSObservationToken?
    private var signatures: [String: Int] = [:]
    private var reconfigureAll = false
    private var lastMessageCount = 0
    private var didInitialScroll = false
    private var shownAsNew: Bool?
    private var scrollButtonShown = false
    /// True until the reader drags away from the end; streaming replies then stay in view.
    private var followsBottom = true
    private var contentSizeObservation: NSKeyValueObservation?

    static let starters = ["Bu ayın postlarını üret", "Yeni ürün duyurusu hazırla", "Bu haftayı planla", "Kullanımı sor"]

    init(model: IOSConversationModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var app: IOSAppModel { model.app }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        navigationItem.title = nil
        buildBarItems()

        tableView.translatesAutoresizingMaskIntoConstraints = false
        tableView.backgroundColor = .clear
        tableView.separatorStyle = .none
        tableView.keyboardDismissMode = .interactive
        tableView.allowsSelection = false
        tableView.delegate = self
        tableView.estimatedRowHeight = 80
        tableView.rowHeight = UITableView.automaticDimension
        tableView.selfSizingInvalidation = .enabledIncludingConstraints
        tableView.register(ChatMessageCell.self, forCellReuseIdentifier: ChatMessageCell.reuseId)
        contentSizeObservation = tableView.observe(\.contentSize, options: [.old, .new]) { [weak self] _, change in
            guard change.oldValue != change.newValue else { return }
            MainActor.assumeIsolated { self?.contentSizeDidChange() }
        }
        tableView.contentInsetAdjustmentBehavior = .automatic
        tableView.contentInset.top = 4
        // Text scrolls under the status bar and the glass buttons with the system's soft edge.
        tableView.topEdgeEffect.style = .soft
        tableView.bottomEdgeEffect.style = .soft
        setContentScrollView(tableView, for: .top)
        setContentScrollView(tableView, for: .bottom)

        composer.host = self
        composer.onSendTapped = { [weak self] in self?.send() }
        composer.starters = Self.starters
        composer.onStarter = { [weak self] starter in self?.useStarter(starter) }
        // The composer floats over the messages: the scroll view softens its edge under it.
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = tableView
        edge.edge = .bottom
        composer.addInteraction(edge)

        home.isHidden = true
        home.onTap = { [weak self] in self?.view.endEditing(true) }

        scrollButton.alpha = 0
        scrollButton.isHidden = true
        scrollButton.addAction(UIAction { [weak self] _ in
            self?.scrollToBottom(animated: true)
            Haptics.selection()
        }, for: .touchUpInside)

        view.addSubview(tableView)
        view.addSubview(home)
        view.addSubview(scrollButton)
        view.addSubview(composer)
        let homeCenter = home.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor, constant: -8)
        homeCenter.priority = .defaultHigh
        // Where the composer sits if the keyboard guide is not tracking yet (off screen).
        let restingComposer = composer.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor)
        restingComposer.priority = .defaultLow
        NSLayoutConstraint.activate([
            tableView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            tableView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            tableView.topAnchor.constraint(equalTo: view.topAnchor),
            tableView.bottomAnchor.constraint(equalTo: view.bottomAnchor),

            home.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 28),
            home.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -28),
            homeCenter,
            home.topAnchor.constraint(greaterThanOrEqualTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            home.bottomAnchor.constraint(lessThanOrEqualTo: composer.topAnchor, constant: -12),

            scrollButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            scrollButton.bottomAnchor.constraint(equalTo: composer.topAnchor, constant: -6),

            composer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
            restingComposer,
        ])

        dataSource = UITableViewDiffableDataSource(tableView: tableView) { [weak self] table, indexPath, row in
            let cell = table.dequeueReusableCell(withIdentifier: ChatMessageCell.reuseId, for: indexPath) as! ChatMessageCell
            self?.configure(cell, row: row)
            return cell
        }
        dataSource.defaultRowAnimation = .fade

        registerForTraitChanges([UITraitPreferredContentSizeCategory.self]) { (self: Self, _) in
            self.reconfigureAll = true
            self.render()
        }

        observation = observeIOS { [weak self] in self?.render() }
        badgeObservation = observeIOS { [weak self] in self?.renderDrawerBadge() }
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        // The greeting follows the clock.
        renderHome()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        app.visibleConversationId = model.id
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if app.visibleConversationId == model.id { app.visibleConversationId = nil }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        updateBottomInset()
    }

    // MARK: Bar items

    private func buildBarItems() {
        drawerItem = UIBarButtonItem(image: UIImage(systemName: "line.3.horizontal.decrease"), primaryAction: UIAction { [weak self] _ in
            self?.view.endEditing(true)
            self?.onOpenDrawer?()
        })
        drawerItem.accessibilityLabel = "Kenar çubuğu"
        drawerItem.accessibilityHint = "Sohbet geçmişini, postları, takvimi, markaları ve ayarları açar"
        navigationItem.leftBarButtonItem = drawerItem

        newChatItem = UIBarButtonItem(image: UIImage(systemName: "square.and.pencil"), primaryAction: UIAction { [weak self] _ in
            self?.app.open(.newConversation)
            Haptics.selection()
        })
        newChatItem.accessibilityLabel = "Yeni sohbet"

        moreItem = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.conversationMenu() ?? [])
        }]))
        moreItem.accessibilityLabel = "Sohbet işlemleri"

        brandItem = UIBarButtonItem(image: UIImage(systemName: "building.2"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.homeMenu() ?? [])
        }]))
        brandItem.accessibilityLabel = "Marka ve model"
    }

    /// Orange dot on the drawer button while something waits on the user (posts to
    /// approve, a consent card in another conversation).
    private func renderDrawerBadge() {
        let waitingElsewhere = app.conversations.contains { $0.id != model.id && app.isWaitingOnUser($0.id) }
        let waiting = app.posts.attentionCount > 0 || waitingElsewhere
        if waiting {
            var badge = UIBarButtonItem.Badge.indicator()
            badge.backgroundColor = IOSTheme.accent
            drawerItem.badge = badge
        } else {
            drawerItem.badge = nil
        }
        drawerItem.accessibilityValue = waiting ? "Bekleyen işler var" : nil
    }

    // MARK: Render

    private func render() {
        if shownAsNew != model.isNew {
            shownAsNew = model.isNew
            navigationItem.rightBarButtonItems = model.isNew ? [brandItem] : [moreItem, newChatItem]
        }
        if model.isNew { model.refreshComposerState() }
        if app.visibleConversationId == nil, view.window != nil { app.visibleConversationId = model.id }
        renderStatusChip()

        var rows: [String] = []
        var newSignatures: [String: Int] = [:]
        let plans = model.state?.plans ?? []
        let aliasesHash = model.state?.aliases.hashValue ?? 0
        let speakingId = MessageSpeaker.shared.speakingId
        for message in model.messages {
            let id = "m:\(message.id)"
            rows.append(id)
            var hasher = Hasher()
            hasher.combine(message)
            hasher.combine(aliasesHash)
            hasher.combine(speakingId == message.id)
            for (index, part) in message.parts.enumerated() {
                switch part {
                case .planProposal(let planId):
                    hasher.combine(plans.first { $0.id == planId })
                    hasher.combine(model.busyPlans.contains(planId))
                    hasher.combine(model.expandedPlans.contains(planId))
                    hasher.combine(app.isOnline)
                case .consent(let consent):
                    hasher.combine(model.busyConsents.contains(message.id + consent.consentId))
                case .question(let question):
                    hasher.combine(model.busyQuestions.contains(message.id + question.questionId))
                    hasher.combine(model.questionSelections[message.id + question.questionId])
                case .contentRef(let ref):
                    hasher.combine(app.posts.card(ref.contentId)?.title)
                case .toolStep:
                    hasher.combine(index)
                default:
                    break
                }
            }
            hasher.combine(model.expandedSteps.filter { $0.hasPrefix(message.id + ":") })
            newSignatures[id] = hasher.finalize()
        }
        if let run = model.activeRun {
            rows.append("run")
            var hasher = Hasher()
            hasher.combine(run)
            hasher.combine(model.runWaitingForMac)
            hasher.combine(app.isOnline)
            newSignatures["run"] = hasher.finalize()
        }

        let changed = reconfigureAll ? rows : rows.filter { signatures[$0] != nil && signatures[$0] != newSignatures[$0] }
        reconfigureAll = false
        signatures = newSignatures
        let grew = model.messages.count != lastMessageCount
        let userSent = grew && model.messages.last?.role == .user
        lastMessageCount = model.messages.count

        renderHome()

        var snapshot = NSDiffableDataSourceSnapshot<Int, String>()
        snapshot.appendSections([0])
        snapshot.appendItems(rows)
        snapshot.reconfigureItems(changed.filter { rows.contains($0) })
        // Only animate rows coming or going. Streaming text only reconfigures rows; animating
        // those fights the pin to the bottom and makes the conversation jump.
        let rowsChanged = dataSource.snapshot().itemIdentifiers != rows
        let animate = didInitialScroll && view.window != nil && rowsChanged
        if userSent { followsBottom = true }
        dataSource.apply(snapshot, animatingDifferences: animate) { [weak self] in
            guard let self else { return }
            if !self.didInitialScroll, !rows.isEmpty, self.model.state != nil || self.model.isNew {
                self.didInitialScroll = true
                self.followsBottom = true
            }
            if self.followsBottom { self.pinToBottom() }
            self.updateScrollButton()
        }
    }

    /// Connection trouble of this conversation, as a small line in the title area.
    private func renderStatusChip() {
        let text: String? = switch model.live {
        case .live: nil
        case .connecting: model.isNew ? nil : "Bağlanıyor…"
        case .waiting: "Bağlantı koptu · yeniden deneniyor"
        case .polling: "Yeniden bağlanıyor…"
        }
        statusChip.text = text
        navigationItem.titleView = text == nil ? nil : statusChip
    }

    /// The empty chat: Studio's mark, the serif greeting, the current brand and the Mac state.
    private func renderHome() {
        let empty = model.messages.isEmpty && model.activeRun == nil
        home.isHidden = !empty
        guard empty else { return }
        let brandTitle = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
        var detail: String?
        var action: (title: String, primary: Bool, run: () -> Void)?
        switch app.connection {
        case .notPaired:
            detail = "Studio Mac'te çalışır. Aynı Wi-Fi'deki Mac'i 6 haneli kodla eşleştir."
            action = ("Eşleştir", true, { [weak self] in self?.app.open(.settings) })
        case .unreachable(let message):
            detail = "Mac'e ulaşılamıyor. \(message)"
            action = ("Yeniden dene", false, { [weak self] in
                guard let self else { return }
                Task { await self.app.load() }
            })
        case .macOffline:
            detail = "Mac çevrimdışı; mesajın Mac açılınca yanıtlanır."
        case .connecting, .online:
            detail = nil
        }
        home.configure(
            greeting: StudioGreeting.text(at: Date(), name: app.settings.greetingName),
            brandTitle: model.isNew ? brandTitle : (app.brand(model.brandId)?.name ?? brandTitle),
            brandMenu: model.isNew ? UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
                guard let self else { return completion([]) }
                completion(StudioMenus.brandSection(self.app, onPick: { self.app.selectBrand($0) }, onProfile: { self.app.open(.brand($0)) }))
            }]) : nil,
            detail: detail, action: action)
    }

    private func configure(_ cell: ChatMessageCell, row: String) {
        if row == "run", let run = model.activeRun {
            cell.configure(views: [runRow(run)])
            return
        }
        let id = String(row.dropFirst(2))
        guard let message = model.messages.first(where: { $0.id == id }) else {
            cell.configure(views: [])
            return
        }
        cell.configure(message: message, context: context)
    }

    private var context: ChatCellContext {
        ChatCellContext(
            model: model,
            onMention: { [weak self] aliasId in self?.previewAlias(id: aliasId) },
            onAttachment: { [weak self] attachment in self?.previewAttachment(attachment) },
            onOpenPost: { [weak self] ref in self?.app.open(.post(ref.contentId)) },
            onEditPlan: { [weak self] _ in
                guard let self else { return }
                self.model.composer.placeholder = "Planda neyi değiştireyim?"
                self.composer.textView.becomeFirstResponder()
            },
            onAnswerText: { [weak self] message, question in self?.answerWithText(message, question) },
            onCopy: { [weak self] message in
                UIPasteboard.general.string = message.plainText
                Haptics.success()
                Toast.show("Kopyalandı", in: self?.view)
            },
            onSpeak: { message in
                MessageSpeaker.shared.toggle(id: message.id, text: message.plainText)
                Haptics.selection()
            },
            onShare: { [weak self] message, source in
                guard let self else { return }
                FileSharing.share([message.plainText], from: self, source: source)
            })
    }

    private func runRow(_ run: AgentRun) -> UIView {
        var views: [UIView] = []
        if run.status == .running {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            views.append(spinner)
            views.append(UILabel.studio("Yanıt hazırlanıyor…", size: 14, color: IOSTheme.textSecondary, style: .subheadline))
        } else {
            views.append(IOSStatusDotView(color: IOSTheme.accent, size: 7))
            let text = model.runWaitingForMac
                ? (app.isOnline ? "Mac'te sohbet ajanı hazır değil; sırada bekliyor" : "Mac çevrimdışı; açılınca yanıtlanacak")
                : "Sırada"
            views.append(UILabel.studio(text, size: 14, color: IOSTheme.textSecondary, lines: 2, style: .subheadline))
        }
        views.append(UIView.spacer())
        views.append(UIButton.studioPill(title: "Durdur", kind: .plain, image: "stop.fill") { [weak self] in
            guard let self else { return }
            Task { await self.model.cancelRun() }
        })
        return UIStackView.h(views, spacing: 8)
    }

    // MARK: Actions

    private func send() {
        guard model.canSend else {
            if let reason = model.composer.sendBlockedReason { Toast.show(reason, in: view) }
            return
        }
        // The keyboard steps aside so the reply has the whole screen.
        view.endEditing(true)
        Task { await model.send() }
    }

    private func useStarter(_ starter: String) {
        Haptics.selection()
        if starter == "Kullanımı sor" {
            Task { await model.sendUsage() }
            return
        }
        model.composer.text = starter
        model.composer.caret = (starter as NSString).length
        composer.textView.becomeFirstResponder()
    }

    /// Brand, model, effort and usage before the first message (the home's right button).
    func homeMenu() -> [UIMenuElement] {
        let brand = StudioMenus.brandSection(app, onPick: { [weak self] in self?.app.selectBrand($0) }, onProfile: { [weak self] in self?.app.open(.brand($0)) })
        return brand + [UIMenu(title: "", options: .displayInline, children: aiMenuElements())]
    }

    private func aiMenuElements() -> [UIMenuElement] {
        let selection = model.selection
        return [
            StudioMenus.modelMenu(selection, presence: model.presence) { [weak self] in self?.model.selection.model = $0 },
            StudioMenus.effortMenu(selection) { [weak self] in self?.model.selection.effort = $0 },
            StudioMenus.usageAction(model.presence) { [weak self] in self?.showUsage() },
        ]
    }

    /// "…": brand, model and effort, usage, images, rename, share, archive.
    func conversationMenu() -> [UIMenuElement] {
        var children: [UIMenuElement] = []
        // A conversation keeps its brand; picking another one starts a new chat there.
        let brandName = app.brand(model.brandId)?.name ?? "Markasız"
        children.append(UIMenu(title: "Marka", subtitle: brandName, image: UIImage(systemName: "building.2"), children: StudioMenus.brandActions(app) { [weak self] brandId in
            guard let self else { return }
            let changes = brandId != self.model.brandId
            self.app.selectBrand(brandId)
            if changes { self.app.open(.newConversation) }
        } + (model.brandId.map { brandId in [UIAction(title: "Marka profili", image: UIImage(systemName: "person.crop.square")) { [weak self] _ in self?.app.open(.brand(brandId)) }] } ?? [])))
        children.append(UIMenu(title: "", options: .displayInline, children: aiMenuElements() + [
            UIAction(title: "Kullanımı sor (/usage)", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
                guard let self else { return }
                Task { await self.model.sendUsage() }
            },
        ]))
        var conversation: [UIMenuElement] = []
        let aliases = model.state?.aliases ?? []
        if !aliases.isEmpty {
            conversation.append(UIMenu(title: "Görseller", image: UIImage(systemName: "photo.stack"), children: aliases.map { alias in
                UIAction(title: "@\(alias.alias)", subtitle: alias.previousAliases.isEmpty ? nil : "eski: \(alias.previousAliases.joined(separator: ", "))") { [weak self] _ in
                    self?.previewAlias(id: alias.id)
                }
            }))
        }
        if !model.isNew {
            conversation.append(UIAction(title: "Yeniden adlandır", image: UIImage(systemName: "pencil")) { [weak self] _ in
                guard let self else { return }
                self.prompt("Sohbeti adlandır", text: self.model.title) { title in Task { await self.model.rename(to: title) } }
            })
            conversation.append(UIAction(title: "Sohbeti paylaş", image: UIImage(systemName: "square.and.arrow.up"), attributes: model.messages.isEmpty ? .disabled : []) { [weak self] _ in
                guard let self else { return }
                FileSharing.share([self.transcript()], from: self, barItem: self.moreItem)
            })
            conversation.append(UIAction(title: "Arşivle", image: UIImage(systemName: "archivebox"), attributes: .destructive) { [weak self] _ in
                guard let self else { return }
                self.confirm("Sohbet arşivlensin mi?", message: "Arşivlenen sohbet listeden kalkar; postlar ve planlar kalır.", action: "Arşivle") {
                    Task {
                        if await self.model.archive() { self.app.open(.newConversation) }
                    }
                }
            })
        }
        children.append(UIMenu(title: "", options: .displayInline, children: conversation))
        return children
    }

    /// The conversation as plain text (sharing).
    func transcript() -> String {
        var lines = ["\(model.title)\n"]
        for message in model.messages {
            let text = message.plainText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { continue }
            lines.append("\(message.role == .user ? "Sen" : "Studio"): \(text)")
        }
        return lines.joined(separator: "\n\n")
    }

    private func showUsage() {
        presentSheet(UsageSheetViewController(app: app, presence: { [weak model] in model?.presence }), detents: [.medium(), .large()])
    }

    private func previewAlias(id: EntityID) {
        guard let alias = model.state?.alias(id: id) else { return }
        presentSheet(AliasPreviewViewController(model: model, assetId: alias.assetId, alias: alias), detents: [.large()])
    }

    private func previewAttachment(_ attachment: AttachmentPart) {
        let alias = attachment.aliasId.flatMap { model.state?.alias(id: $0) } ?? model.state?.aliases.first { $0.assetId == attachment.assetId }
        presentSheet(AliasPreviewViewController(model: model, assetId: attachment.assetId, alias: alias), detents: [.large()])
    }

    private func answerWithText(_ message: Message, _ question: QuestionPart) {
        let picked = Array(model.questionSelections[message.id + question.questionId] ?? [])
        prompt(question.prompt, text: nil, placeholder: "Yanıtın", action: "Gönder") { [weak self] text in
            guard let self else { return }
            Task { await self.model.answer(message: message, question: question, optionIds: picked, text: text) }
        }
    }

    // MARK: Scrolling

    /// Messages scroll under the floating composer: keep the last one above it.
    private func updateBottomInset() {
        let overlap = max(0, view.bounds.height - composer.frame.minY)
        let inset = max(0, overlap - view.safeAreaInsets.bottom) + 8
        guard abs(tableView.contentInset.bottom - inset) > 0.5 else { return }
        tableView.contentInset.bottom = inset
        tableView.verticalScrollIndicatorInsets.bottom = inset
        if didInitialScroll && followsBottom { pinToBottom() }
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        // Only the reader's own drags decide whether we keep following the reply.
        if scrollView.isTracking || scrollView.isDecelerating {
            followsBottom = isNearBottom(threshold: 40)
        }
        updateScrollButton()
    }

    /// Growing content (streamed text, cells measuring themselves) keeps the end in view
    /// while the reader follows the conversation.
    private func contentSizeDidChange() {
        guard didInitialScroll, followsBottom, !tableView.isTracking, !tableView.isDecelerating else { return }
        pinToBottom()
    }

    private var bottomOffset: CGFloat {
        let inset = tableView.adjustedContentInset
        return max(-inset.top, tableView.contentSize.height + inset.bottom - tableView.bounds.height)
    }

    /// Sits exactly at the end without animation, so repeated updates never stack up.
    private func pinToBottom() {
        let target = bottomOffset
        guard abs(tableView.contentOffset.y - target) > 0.5 else { return }
        tableView.setContentOffset(CGPoint(x: 0, y: target), animated: false)
    }

    private func updateScrollButton() {
        let visible = tableView.bounds.height - tableView.adjustedContentInset.top - tableView.adjustedContentInset.bottom
        let show = !home.isHidden ? false : (tableView.contentSize.height > visible + 40 && !isNearBottom(threshold: 160))
        guard show != scrollButtonShown else { return }
        scrollButtonShown = show
        if show { scrollButton.isHidden = false }
        UIView.animate(withDuration: 0.2, animations: {
            self.scrollButton.alpha = show ? 1 : 0
            self.scrollButton.transform = show ? .identity : CGAffineTransform(scaleX: 0.8, y: 0.8)
        }, completion: { _ in
            if !self.scrollButtonShown { self.scrollButton.isHidden = true }
        })
    }

    private func isNearBottom(threshold: CGFloat = 120) -> Bool {
        let visible = tableView.bounds.height - tableView.adjustedContentInset.bottom
        return tableView.contentOffset.y + visible >= tableView.contentSize.height - threshold
    }

    private func scrollToBottom(animated: Bool) {
        followsBottom = true
        guard tableView.numberOfRows(inSection: 0) > 0 else { return }
        tableView.setContentOffset(CGPoint(x: 0, y: bottomOffset), animated: animated)
    }
}

/// The home of an empty chat: Studio's orange mark, a serif greeting, the current brand
/// (a menu to switch) and, when needed, the Mac's state with one action.
final class ChatHomeView: UIView {
    let mark = StudioMarkView(size: 18)
    let greetingLabel = UILabel()
    let brandButton = UIButton(type: .system)
    let detailLabel = UILabel.studio("", size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
    private let actionRow = UIStackView()
    var onTap: (() -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        greetingLabel.translatesAutoresizingMaskIntoConstraints = false
        greetingLabel.font = IOSTheme.serif(30, .regular, style: .title1)
        greetingLabel.adjustsFontForContentSizeCategory = true
        greetingLabel.textColor = IOSTheme.textPrimary
        greetingLabel.textAlignment = .center
        greetingLabel.numberOfLines = 0
        greetingLabel.accessibilityTraits = .header
        detailLabel.textAlignment = .center
        brandButton.translatesAutoresizingMaskIntoConstraints = false
        brandButton.showsMenuAsPrimaryAction = true
        brandButton.accessibilityHint = "Markayı değiştirir"
        actionRow.axis = .horizontal
        actionRow.spacing = 8
        let stack = UIStackView.v([mark, greetingLabel, brandButton, detailLabel, actionRow], spacing: 14, alignment: .center)
        stack.setCustomSpacing(18, after: mark)
        stack.setCustomSpacing(4, after: greetingLabel)
        addSubview(stack)
        stack.pin(to: self)
        let tap = UITapGestureRecognizer(target: self, action: #selector(tapped))
        tap.cancelsTouchesInView = false
        addGestureRecognizer(tap)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    @objc private func tapped() { onTap?() }

    func configure(greeting: String, brandTitle: String, brandMenu: UIMenu?, detail: String?, action: (title: String, primary: Bool, run: () -> Void)?) {
        greetingLabel.text = greeting
        var config = UIButton.Configuration.plain()
        config.attributedTitle = AttributedString(brandTitle, attributes: AttributeContainer([
            .font: IOSTheme.font(15, .medium, style: .subheadline), .foregroundColor: IOSTheme.textSecondary,
        ]))
        if brandMenu != nil {
            config.image = UIImage(systemName: "chevron.down", withConfiguration: UIImage.SymbolConfiguration(pointSize: 10, weight: .semibold))
            config.imagePlacement = .trailing
            config.imagePadding = 5
        }
        config.baseForegroundColor = IOSTheme.textSecondary
        config.contentInsets = NSDirectionalEdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10)
        brandButton.configuration = config
        brandButton.menu = brandMenu
        brandButton.isUserInteractionEnabled = brandMenu != nil
        brandButton.accessibilityLabel = "Marka: \(brandTitle)"
        detailLabel.text = detail
        detailLabel.isHidden = detail == nil
        actionRow.removeAllArranged()
        if let action {
            actionRow.addArrangedSubview(UIButton.studioPill(title: action.title, kind: action.primary ? .primary : .secondary, action: action.run))
        }
        actionRow.isHidden = action == nil
    }
}
