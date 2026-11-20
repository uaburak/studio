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
        // No ready-made starter prompts on the empty chat: just the greeting and the composer.
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
        // Pushed (a post's own chat): the back button, not the drawer.
        if let navigation = navigationController, navigation.viewControllers.first !== self {
            navigationItem.leftBarButtonItem = nil
        }
        // The greeting follows the clock.
        renderHome()
    }

    /// Opened from a post's field: typing starts right away.
    var focusComposerOnAppear = false

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        app.visibleConversationId = model.id
        if focusComposerOnAppear {
            focusComposerOnAppear = false
            composer.textView.becomeFirstResponder()
        }
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
        drawerItem = UIBarButtonItem(image: UIImage(systemName: "text.alignleft"), primaryAction: UIAction { [weak self] _ in
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
            navigationItem.rightBarButtonItems = [moreItem]
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
        // The conversation's name in the middle of the bar; connection trouble as a line under it
        // (an empty chat has no name, so the trouble line stands alone).
        let title = model.isNew ? nil : model.title
        if navigationItem.title != title { navigationItem.title = title }
        if title == nil {
            navigationItem.subtitle = nil
            navigationItem.titleView = text == nil ? nil : statusChip
        } else {
            navigationItem.titleView = nil
            if navigationItem.subtitle != text { navigationItem.subtitle = text }
        }
    }

    /// The empty chat: Studio's mark, the serif greeting, the current brand and the Mac state.
    private func renderHome() {
        let empty = model.messages.isEmpty && model.activeRun == nil
        home.isHidden = !empty
        guard empty else { return }
        let brandTitle = app.currentBrand?.name ?? (app.brands.isEmpty ? "Marka yok" : "Marka seç")
        var detail: String?
        var action: (title: String, primary: Bool, run: () -> Void)?
        let connection = app.connection
        switch connection {
        case .notPaired:
            detail = "Studio Mac'inde çalışır. Mac'teki QR kodu okutarak iPhone'u bağla."
            action = (MacLinkAction.pair.title, true, { [weak self] in self?.app.open(.pair) })
        case .unreachable(let reason, let linkAction):
            detail = "\(connection.title). \(reason)"
            action = (linkAction.title, linkAction == .repair, { [weak self] in
                guard let self else { return }
                if linkAction == .repair { self.app.open(.pair) } else { self.app.retryConnection() }
            })
        case .connected:
            detail = app.isMacIdle ? "Mac'e bağlı; Studio şu an iş almıyor, mesajın sonra yanıtlanır." : nil
        case .connecting:
            detail = nil
        }
        home.configure(
            greeting: StudioGreeting.text(at: Date(), name: app.greetingName),
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
            onAttachment: { [weak self] attachment, source in self?.previewAttachment(attachment, source: source) },
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

    /// "…" (the only button at the top right, empty or not): new chat, usage, images, rename,
    /// share, archive. Brand and model are not here (the drawer and the composer have them).
    func conversationMenu() -> [UIMenuElement] {
        var children: [UIMenuElement] = []
        var top: [UIMenuElement] = []
        if !model.isNew {
            top.append(UIAction(title: "Yeni sohbet", image: UIImage(systemName: "square.and.pencil")) { [weak self] _ in
                self?.app.open(.newConversation)
            })
        }
        top.append(StudioMenus.usageAction(model.presence) { [weak self] in self?.showUsage() })
        if !model.isNew {
            top.append(UIAction(title: "Kullanımı sor (/usage)", image: UIImage(systemName: "text.bubble")) { [weak self] _ in
                guard let self else { return }
                Task { await self.model.sendUsage() }
            })
        }
        children.append(UIMenu(title: "", options: .displayInline, children: top))
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
        presentPhoto(assetId: alias.assetId, alias: alias, source: nil)
    }

    private func presentPhoto(assetId: EntityID, alias: ConversationAlias?, source: UIView?) {
        // Every picture attached to the conversation, so the viewer can page through them.
        let aliases = (model.state?.aliases ?? []).filter { $0.kind != .video }
        var byAsset: [EntityID: ConversationAlias] = [:]
        for a in aliases where byAsset[a.assetId] == nil { byAsset[a.assetId] = a }
        var items = aliases.map { a -> PhotoViewerItem in
            let aspect: CGFloat? = (a.width ?? 0) > 0 && (a.height ?? 0) > 0 ? CGFloat(a.width ?? 1) / CGFloat(a.height ?? 1) : nil
            return PhotoViewerItem(assetId: a.assetId, title: a.alias.isEmpty ? "Görsel" : "@\(a.alias)", subtitle: PhotoViewerItem.addedText(a.createdAt), aspect: aspect)
        }
        if !items.contains(where: { $0.assetId == assetId }) {
            items.insert(PhotoViewerItem(assetId: assetId, title: "Görsel", aspect: nil), at: 0)
        }
        let start = items.firstIndex { $0.assetId == assetId } ?? 0
        let viewer = PhotoViewerViewController(images: model.app.images, items: items, index: start, sourceFor: { _ in source }) { [weak self] item in
            guard let alias = byAsset[item.assetId], !alias.alias.isEmpty else { return PhotoViewerBar() }
            return PhotoViewerBar(
                menu: [PhotoViewerAction(label: "Yeniden adlandır", symbol: "pencil") { viewer, item in
                    guard let self, let current = byAsset[item.assetId] else { return }
                    viewer.prompt("Takma ad", message: "Eski ad bu sohbette kullanılmaya devam eder.", text: current.alias) { name in
                        Task {
                            if let problem = await self.model.renameAlias(current, to: name) {
                                viewer.presentError(problem)
                            } else {
                                let normalized = ImageAlias.normalize(name)
                                byAsset[item.assetId]?.alias = normalized
                                viewer.updateTitle("@\(normalized)")
                                Haptics.success()
                            }
                        }
                    }
                }],
                trailing: PhotoViewerAction(label: "Mesaja ekle", symbol: "at") { viewer, item in
                    guard let self, let current = byAsset[item.assetId] else { return }
                    self.model.composer.appendMention(current.alias)
                    viewer.close()
                })
        }
        viewer.open(from: self)
    }

    private func previewAttachment(_ attachment: AttachmentPart, source: UIView) {
        let alias = attachment.aliasId.flatMap { model.state?.alias(id: $0) } ?? model.state?.aliases.first { $0.assetId == attachment.assetId }
        presentPhoto(assetId: attachment.assetId, alias: alias, source: source)
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

extension IOSChatViewController: FloatingComposerHost {
    var floatingComposer: UIView { composer }
    var floatingComposerPill: UIView { composer.pill }
}
