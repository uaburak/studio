import Foundation
import Observation
import PhotosUI
import StudioKit
import UIKit

/// Pure UIKit conversation model for `StudioIOS`.
@MainActor
@Observable
final class IOSConversationModel {
    struct DraftAttachment: Identifiable, Equatable {
        var id = UUID()
        var alias: String
        var thumbnail: UIImage
        var assetId: EntityID?
        var isUploading: Bool
    }

    let id: EntityID
    unowned let app: IOSAppModel
    private(set) var state: ConversationState?
    private(set) var live: LiveState = .connecting(attempt: 1)

    var composerText = ""
    var drafts: [DraftAttachment] = []
    var isSending = false
    var error: String?

    var busyPlans: Set<EntityID> = []
    var busyQuestions: Set<String> = []
    var busyConsents: Set<String> = []

    var agentChoice: IOSAgentChoice {
        didSet { app.agentChoice = agentChoice }
    }

    private var streamTask: Task<Void, Never>?
    private var allocator = AliasAllocator()

    init(id: EntityID, app: IOSAppModel) {
        self.id = id
        self.app = app
        self.agentChoice = app.agentChoice
    }

    var brandId: EntityID? {
        state?.conversation.brandId ?? app.conversations.first { $0.id == id }?.brandId ?? app.currentBrandId
    }

    var messages: [Message] { state?.messages ?? [] }
    var activeRun: AgentRun? { state?.activeRun }
    var isUploadingDrafts: Bool { drafts.contains(where: \.isUploading) }

    var canSend: Bool {
        let hasText = !composerText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        let hasAttachments = !drafts.isEmpty && drafts.allSatisfy { $0.assetId != nil }
        return (hasText || hasAttachments) && !isUploadingDrafts && !isSending && activeRun == nil
    }

    func start() {
        guard streamTask == nil else { return }
        let stream = app.conversationService.observe(id)
        streamTask = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                switch event {
                case .state(let liveState):
                    self.live = liveState
                case .conversation(let next):
                    let changed = self.state?.conversation != next.conversation
                    self.state = next
                    self.allocator = AliasAllocator(aliases: next.aliases)
                    if changed { self.app.conversationUpdated(next.conversation) }
                }
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    func addPhoto(_ image: UIImage, filename: String = "fotograf.jpg") {
        guard let brandId else {
            error = "Bu sohbetin markası yok."
            return
        }
        do {
            let imported = try IOSImageImport.from(image: image, filename: filename)
            let alias = allocator.next()
            let draft = DraftAttachment(alias: alias, thumbnail: imported.thumbnail, assetId: nil, isUploading: true)
            drafts.append(draft)
            let draftId = draft.id
            Task {
                do {
                    let asset = try await app.conversationService.uploadImage(imported.file, brandId: brandId) { _ in }
                    app.images.seed(imported.thumbnail, for: asset.id)
                    if let idx = drafts.firstIndex(where: { $0.id == draftId }) {
                        drafts[idx].assetId = asset.id
                        drafts[idx].isUploading = false
                    }
                } catch {
                    drafts.removeAll { $0.id == draftId }
                    self.error = IOSAppModel.describe(error)
                }
            }
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func removeDraft(_ id: UUID) {
        drafts.removeAll { $0.id == id }
    }

    func send(overrideText: String? = nil) async {
        let text = (overrideText ?? composerText).trimmingCharacters(in: .whitespacesAndNewlines)
        let outgoingAttachments = drafts.compactMap { d -> OutgoingAttachment? in
            guard let aid = d.assetId else { return nil }
            return OutgoingAttachment(assetId: aid, alias: d.alias)
        }
        guard !text.isEmpty || !outgoingAttachments.isEmpty else { return }
        guard !isSending else { return }
        isSending = true
        defer { isSending = false }

        let msg = OutgoingMessage(
            text: text,
            attachments: outgoingAttachments,
            model: agentChoice.model,
            effort: agentChoice.effort
        )
        do {
            _ = try await app.conversationService.send(msg, to: id)
            if overrideText == nil {
                composerText = ""
                drafts = []
            }
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func decideConsent(message: Message, consent: ConsentPart, allow: Bool) async {
        let key = message.id + consent.consentId
        busyConsents.insert(key)
        defer { busyConsents.remove(key) }
        do {
            _ = try await app.conversationService.decideConsent(
                conversationId: id,
                messageId: message.id,
                ConsentDecisionCreate(consentId: consent.consentId, allow: allow)
            )
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func answer(message: Message, question: QuestionPart, optionId: String) async {
        let key = message.id + question.questionId
        busyQuestions.insert(key)
        defer { busyQuestions.remove(key) }
        do {
            _ = try await app.conversationService.answer(
                conversationId: id,
                messageId: message.id,
                QuestionAnswerCreate(questionId: question.questionId, optionIds: [optionId], text: nil)
            )
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func acceptAndGenerate(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            _ = try await app.conversationService.acceptAndGenerate(plan, model: agentChoice.model, effort: agentChoice.effort)
            await app.posts.load()
            error = nil
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func rejectPlan(_ plan: Plan) async {
        busyPlans.insert(plan.id)
        defer { busyPlans.remove(plan.id) }
        do {
            _ = try await app.conversationService.rejectPlan(plan.id, reason: nil)
        } catch {
            self.error = IOSAppModel.describe(error)
        }
    }

    func cancelActiveRun() async {
        guard let run = activeRun else { return }
        _ = try? await app.conversationService.cancelRun(run.id)
    }
}

// MARK: - IOSChatViewController (100% Pure UIKit)

final class IOSChatViewController: UIViewController, PHPickerViewControllerDelegate, UITextFieldDelegate {
    let model: IOSConversationModel

    private let scrollView = UIScrollView()
    private let messagesStack = UIStackView()
    private let composerContainer = UIView()
    private let draftsScroll = UIScrollView()
    private let draftsStack = UIStackView()
    private let textField = UITextField()
    private let sendButton = UIButton(type: .system)
    private let modelMenuButton = UIButton(type: .system)
    private let effortMenuButton = UIButton(type: .system)
    private let errorLabel = UILabel.studio("", size: 12, color: .systemRed, lines: 2)

    private var observation: IOSObservationToken?

    init(model: IOSConversationModel) {
        self.model = model
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas

        let usageItem = UIBarButtonItem(
            title: "/usage",
            primaryAction: UIAction { [weak self] _ in
                guard let self else { return }
                Task { await self.model.send(overrideText: "/usage") }
            }
        )
        navigationItem.rightBarButtonItem = usageItem

        scrollView.translatesAutoresizingMaskIntoConstraints = false
        scrollView.keyboardDismissMode = .interactive
        messagesStack.axis = .vertical
        messagesStack.alignment = .fill
        messagesStack.spacing = 14
        messagesStack.translatesAutoresizingMaskIntoConstraints = false
        scrollView.addSubview(messagesStack)

        buildComposer()

        view.addSubview(scrollView)
        view.addSubview(composerContainer)

        NSLayoutConstraint.activate([
            scrollView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scrollView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scrollView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            scrollView.bottomAnchor.constraint(equalTo: composerContainer.topAnchor),

            messagesStack.leadingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.leadingAnchor, constant: 16),
            messagesStack.trailingAnchor.constraint(equalTo: scrollView.contentLayoutGuide.trailingAnchor, constant: -16),
            messagesStack.topAnchor.constraint(equalTo: scrollView.contentLayoutGuide.topAnchor, constant: 16),
            messagesStack.bottomAnchor.constraint(equalTo: scrollView.contentLayoutGuide.bottomAnchor, constant: -16),
            messagesStack.widthAnchor.constraint(equalTo: scrollView.frameLayoutGuide.widthAnchor, constant: -32),

            composerContainer.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            composerContainer.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            composerContainer.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])

        observation = observeIOS { [weak self] in
            self?.render()
        }
    }

    private func buildComposer() {
        composerContainer.translatesAutoresizingMaskIntoConstraints = false
        composerContainer.backgroundColor = IOSTheme.canvas

        let topBorder = UIView()
        topBorder.translatesAutoresizingMaskIntoConstraints = false
        topBorder.backgroundColor = IOSTheme.hairline
        composerContainer.addSubview(topBorder)

        draftsScroll.translatesAutoresizingMaskIntoConstraints = false
        draftsScroll.showsHorizontalScrollIndicator = false
        draftsScroll.isHidden = true
        draftsStack.axis = .horizontal
        draftsStack.spacing = 8
        draftsStack.translatesAutoresizingMaskIntoConstraints = false
        draftsScroll.addSubview(draftsStack)

        let attachBtn = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in
            self?.presentPhotoPicker()
        })
        attachBtn.setImage(UIImage(systemName: "photo.badge.plus"), for: .normal)
        attachBtn.tintColor = IOSTheme.textSecondary
        attachBtn.translatesAutoresizingMaskIntoConstraints = false

        textField.placeholder = "Ne üretelim? (@alias ile görsel an)"
        textField.font = UIFont.systemFont(ofSize: 15)
        textField.textColor = IOSTheme.textPrimary
        textField.backgroundColor = IOSTheme.fill
        textField.layer.cornerRadius = 18
        textField.leftView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        textField.leftViewMode = .always
        textField.rightView = UIView(frame: CGRect(x: 0, y: 0, width: 12, height: 1))
        textField.rightViewMode = .always
        textField.returnKeyType = .send
        textField.delegate = self
        textField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.model.composerText = self.textField.text ?? ""
        }, for: .editingChanged)
        textField.translatesAutoresizingMaskIntoConstraints = false
        textField.heightAnchor.constraint(equalToConstant: 38).isActive = true

        sendButton.setImage(UIImage(systemName: "arrow.up.circle.fill"), for: .normal)
        sendButton.tintColor = IOSTheme.accent
        sendButton.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            Task { await self.model.send() }
        }, for: .touchUpInside)
        sendButton.translatesAutoresizingMaskIntoConstraints = false

        let inputRow = UIStackView(arrangedSubviews: [attachBtn, textField, sendButton])
        inputRow.axis = .horizontal
        inputRow.alignment = .center
        inputRow.spacing = 8

        modelMenuButton.showsMenuAsPrimaryAction = true
        modelMenuButton.titleLabel?.font = UIFont.systemFont(ofSize: 12, weight: .medium)
        effortMenuButton.showsMenuAsPrimaryAction = true
        effortMenuButton.titleLabel?.font = UIFont.systemFont(ofSize: 12, weight: .medium)

        let footerSpacer = UIView()
        let footerRow = UIStackView(arrangedSubviews: [modelMenuButton, effortMenuButton, footerSpacer])
        footerRow.axis = .horizontal
        footerRow.alignment = .center
        footerRow.spacing = 12

        errorLabel.isHidden = true

        let outer = UIStackView(arrangedSubviews: [errorLabel, draftsScroll, inputRow, footerRow])
        outer.axis = .vertical
        outer.spacing = 8
        outer.translatesAutoresizingMaskIntoConstraints = false
        composerContainer.addSubview(outer)

        NSLayoutConstraint.activate([
            topBorder.leadingAnchor.constraint(equalTo: composerContainer.leadingAnchor),
            topBorder.trailingAnchor.constraint(equalTo: composerContainer.trailingAnchor),
            topBorder.topAnchor.constraint(equalTo: composerContainer.topAnchor),
            topBorder.heightAnchor.constraint(equalToConstant: 1),

            draftsScroll.heightAnchor.constraint(equalToConstant: 52),
            draftsStack.leadingAnchor.constraint(equalTo: draftsScroll.contentLayoutGuide.leadingAnchor),
            draftsStack.trailingAnchor.constraint(equalTo: draftsScroll.contentLayoutGuide.trailingAnchor),
            draftsStack.topAnchor.constraint(equalTo: draftsScroll.contentLayoutGuide.topAnchor),
            draftsStack.bottomAnchor.constraint(equalTo: draftsScroll.contentLayoutGuide.bottomAnchor),
            draftsStack.heightAnchor.constraint(equalTo: draftsScroll.frameLayoutGuide.heightAnchor),

            outer.leadingAnchor.constraint(equalTo: composerContainer.leadingAnchor, constant: 12),
            outer.trailingAnchor.constraint(equalTo: composerContainer.trailingAnchor, constant: -12),
            outer.topAnchor.constraint(equalTo: composerContainer.topAnchor, constant: 8),
            outer.bottomAnchor.constraint(equalTo: composerContainer.safeAreaLayoutGuide.bottomAnchor, constant: -8),
        ])
    }

    func textFieldShouldReturn(_ textField: UITextField) -> Bool {
        if model.canSend {
            Task { await model.send() }
        }
        return false
    }

    private func render() {
        title = model.state?.conversation.displayTitle ?? "Sohbet"
        if textField.text != model.composerText {
            textField.text = model.composerText
        }
        sendButton.isEnabled = model.canSend

        if let err = model.error {
            errorLabel.text = err
            errorLabel.isHidden = false
        } else {
            errorLabel.isHidden = true
        }

        // Model & Effort menus
        modelMenuButton.setTitle("\(model.agentChoice.model.displayName) ▾", for: .normal)
        let geminiMenu = UIMenu(title: "Gemini", options: .displayInline, children: AgentModel.geminiCases.map { m in
            UIAction(title: m.displayName, state: m == model.agentChoice.model ? .on : .off) { [weak self] _ in
                self?.model.agentChoice.model = m
            }
        })
        let claudeMenu = UIMenu(title: "Claude", options: .displayInline, children: AgentModel.claudeCases.map { m in
            UIAction(title: m.displayName, state: m == model.agentChoice.model ? .on : .off) { [weak self] _ in
                self?.model.agentChoice.model = m
            }
        })
        modelMenuButton.menu = UIMenu(title: "Model Seç", children: [geminiMenu, claudeMenu])

        effortMenuButton.setTitle("Düşünme: \(model.agentChoice.effort.displayName) ▾", for: .normal)
        effortMenuButton.menu = UIMenu(title: "Düşünme Düzeyi", children: AgentEffort.knownCases.map { e in
            UIAction(title: e.displayName, state: e == model.agentChoice.effort ? .on : .off) { [weak self] _ in
                self?.model.agentChoice.effort = e
            }
        })

        // Draft attachments
        draftsStack.arrangedSubviews.forEach {
            draftsStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        draftsScroll.isHidden = model.drafts.isEmpty
        for draft in model.drafts {
            let chip = makeDraftChip(draft)
            draftsStack.addArrangedSubview(chip)
        }

        // Messages
        rebuildMessages()
    }

    private func makeDraftChip(_ draft: IOSConversationModel.DraftAttachment) -> UIView {
        let box = UIView()
        box.backgroundColor = IOSTheme.fill
        box.layer.cornerRadius = 10
        box.translatesAutoresizingMaskIntoConstraints = false

        let iv = UIImageView(image: draft.thumbnail)
        iv.contentMode = .scaleAspectFill
        iv.clipsToBounds = true
        iv.layer.cornerRadius = 6
        iv.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iv.widthAnchor.constraint(equalToConstant: 36),
            iv.heightAnchor.constraint(equalToConstant: 36),
        ])

        let aliasLbl = UILabel.studio("@\(draft.alias)\(draft.isUploading ? "…" : "")", size: 12, weight: .semibold)
        let removeBtn = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in
            self?.model.removeDraft(draft.id)
            self?.textField.text = self?.model.composerText
        })
        removeBtn.setImage(UIImage(systemName: "xmark.circle.fill"), for: .normal)
        removeBtn.tintColor = IOSTheme.textSecondary

        let insertBtn = UIButton(type: .system, primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            let prefix = self.model.composerText.isEmpty || self.model.composerText.hasSuffix(" ") ? "" : " "
            self.model.composerText += "\(prefix)@\(draft.alias) "
            self.textField.text = self.model.composerText
        })
        insertBtn.setTitle("Ekle", for: .normal)
        insertBtn.titleLabel?.font = UIFont.systemFont(ofSize: 11, weight: .semibold)

        let row = UIStackView(arrangedSubviews: [iv, aliasLbl, insertBtn, removeBtn])
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 6
        row.translatesAutoresizingMaskIntoConstraints = false
        box.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: box.leadingAnchor, constant: 6),
            row.trailingAnchor.constraint(equalTo: box.trailingAnchor, constant: -6),
            row.centerYAnchor.constraint(equalTo: box.centerYAnchor),
        ])
        return box
    }

    private func rebuildMessages() {
        messagesStack.arrangedSubviews.forEach {
            messagesStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }

        let plansById = Dictionary(uniqueKeysWithValues: (model.state?.plans ?? []).map { ($0.id, $0) })

        for message in model.messages {
            if message.role == .user {
                messagesStack.addArrangedSubview(makeUserBubble(message))
            } else {
                messagesStack.addArrangedSubview(makeAssistantBlock(message, plansById: plansById))
            }
        }

        if let run = model.activeRun {
            let row = UIStackView()
            row.axis = .horizontal
            row.alignment = .center
            row.spacing = 8
            let spin = UIActivityIndicatorView(style: .medium)
            spin.startAnimating()
            let txt = run.status == .queued && !model.app.isOnline
                ? "Mac çevrimdışı · açılınca yanıtlanacak"
                : "Yanıt hazırlanıyor…"
            let stopBtn = UIButton.studioPill(title: "Durdur") { [weak self] in
                guard let self else { return }
                Task { await self.model.cancelActiveRun() }
            }
            row.addArrangedSubview(spin)
            row.addArrangedSubview(UILabel.studio(txt, size: 13, color: IOSTheme.textSecondary))
            row.addArrangedSubview(UIView())
            row.addArrangedSubview(stopBtn)
            messagesStack.addArrangedSubview(row)
        }
    }

    private func makeUserBubble(_ message: Message) -> UIView {
        let wrapper = UIStackView()
        wrapper.axis = .horizontal
        wrapper.addArrangedSubview(UIView())

        let bubble = UIView()
        bubble.backgroundColor = IOSTheme.fill
        bubble.layer.cornerRadius = 18
        bubble.translatesAutoresizingMaskIntoConstraints = false

        let inner = UIStackView()
        inner.axis = .vertical
        inner.spacing = 6
        inner.translatesAutoresizingMaskIntoConstraints = false

        for part in message.parts {
            switch part {
            case .attachment(let att):
                let tag = UILabel.studio("📎 @\(att.alias ?? "görsel")", size: 12, weight: .semibold, color: IOSTheme.accent)
                inner.addArrangedSubview(tag)
            case .text(let t):
                inner.addArrangedSubview(UILabel.studio(t, size: 15, color: IOSTheme.textPrimary, lines: 0))
            default:
                break
            }
        }

        bubble.addSubview(inner)
        NSLayoutConstraint.activate([
            inner.leadingAnchor.constraint(equalTo: bubble.leadingAnchor, constant: 14),
            inner.trailingAnchor.constraint(equalTo: bubble.trailingAnchor, constant: -14),
            inner.topAnchor.constraint(equalTo: bubble.topAnchor, constant: 10),
            inner.bottomAnchor.constraint(equalTo: bubble.bottomAnchor, constant: -10),
            bubble.widthAnchor.constraint(lessThanOrEqualToConstant: 290),
        ])
        wrapper.addArrangedSubview(bubble)
        return wrapper
    }

    private func makeAssistantBlock(_ message: Message, plansById: [EntityID: Plan]) -> UIView {
        let block = UIStackView()
        block.axis = .vertical
        block.alignment = .fill
        block.spacing = 10

        for part in message.parts {
            switch part {
            case .text(let text):
                block.addArrangedSubview(UILabel.studio(text, size: 15, color: IOSTheme.textPrimary, lines: 0))

            case .toolStep(let step):
                block.addArrangedSubview(makeToolStepRow(step))

            case .progress(let prog):
                let suffix = (prog.current != nil && prog.total != nil) ? " (\(prog.current!)/\(prog.total!))" : ""
                block.addArrangedSubview(UILabel.studio("• \(prog.label)\(suffix)", size: 12, color: IOSTheme.textSecondary))

            case .consent(let consent):
                block.addArrangedSubview(makeConsentCard(message: message, consent: consent))

            case .question(let question):
                block.addArrangedSubview(makeQuestionCard(message: message, question: question))

            case .planProposal(let planId):
                if let plan = plansById[planId] {
                    block.addArrangedSubview(makePlanCard(plan))
                }

            case .attachment(let att):
                let img = IOSAssetImageView(store: model.app.images, assetId: att.assetId, cornerRadius: 12)
                img.heightAnchor.constraint(equalToConstant: 180).isActive = true
                block.addArrangedSubview(img)

            case .contentRef(let ref):
                let vTag = ref.version.map { " · v\($0)" } ?? ""
                let note = ref.note.map { " — \($0)" } ?? ""
                let btn = UIButton.studioPill(title: "Post\(vTag)\(note)") { [weak self] in
                    self?.model.app.selectedTab = .posts
                }
                let row = UIStackView(arrangedSubviews: [btn, UIView()])
                row.axis = .horizontal
                block.addArrangedSubview(row)

            case .error(let err):
                block.addArrangedSubview(UILabel.studio("Hata: \(err.message)", size: 13, weight: .medium, color: .systemRed, lines: 0))

            case .unknown:
                break
            }
        }
        return block
    }

    private func makeToolStepRow(_ step: ToolStepPart) -> UIView {
        let row = UIStackView()
        row.axis = .horizontal
        row.alignment = .center
        row.spacing = 6

        if step.state == .running {
            let spin = UIActivityIndicatorView(style: .medium)
            spin.transform = CGAffineTransform(scaleX: 0.75, y: 0.75)
            spin.startAnimating()
            row.addArrangedSubview(spin)
        } else {
            let iconName = step.state == .error ? "exclamationmark.triangle.fill" : "checkmark.circle.fill"
            let iv = UIImageView(image: UIImage(systemName: iconName))
            iv.tintColor = step.state == .error ? IOSTheme.accent : IOSTheme.textSecondary
            iv.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([
                iv.widthAnchor.constraint(equalToConstant: 14),
                iv.heightAnchor.constraint(equalToConstant: 14),
            ])
            row.addArrangedSubview(iv)
        }

        let summary = step.summary.map { " · \($0)" } ?? ""
        row.addArrangedSubview(UILabel.studio("\(step.label)\(summary)", size: 12, color: IOSTheme.textSecondary, lines: 2))
        return row
    }

    private func makeConsentCard(message: Message, consent: ConsentPart) -> UIView {
        let card = IOSCardView(padding: 14, spacing: 8)
        card.stack.addArrangedSubview(UILabel.studio(consent.title, size: 14, weight: .semibold, lines: 0))
        if let detail = consent.detail, !detail.isEmpty {
            card.stack.addArrangedSubview(UILabel.studio(detail, size: 12, color: IOSTheme.textSecondary, lines: 0))
        }
        let busy = model.busyConsents.contains(message.id + consent.consentId)
        switch consent.state {
        case .pending:
            let allowBtn = UIButton.studioPill(title: "Bir kez izin ver", primary: true) { [weak self] in
                guard let self else { return }
                Task { await self.model.decideConsent(message: message, consent: consent, allow: true) }
            }
            allowBtn.isEnabled = !busy
            let denyBtn = UIButton.studioPill(title: "Reddet") { [weak self] in
                guard let self else { return }
                Task { await self.model.decideConsent(message: message, consent: consent, allow: false) }
            }
            denyBtn.isEnabled = !busy
            let actions = UIStackView(arrangedSubviews: [allowBtn, denyBtn, UIView()])
            actions.axis = .horizontal
            actions.spacing = 8
            card.stack.addArrangedSubview(actions)
        case .allowed:
            card.stack.addArrangedSubview(UILabel.studio("✓ İzin verildi", size: 12, weight: .medium, color: IOSTheme.textSecondary))
        case .denied:
            card.stack.addArrangedSubview(UILabel.studio("✕ Reddedildi", size: 12, weight: .medium, color: IOSTheme.textSecondary))
        case .expired, .unknown:
            card.stack.addArrangedSubview(UILabel.studio("Süresi doldu", size: 12, color: IOSTheme.textTertiary))
        }
        return card
    }

    private func makeQuestionCard(message: Message, question: QuestionPart) -> UIView {
        let card = IOSCardView(padding: 14, spacing: 8)
        card.stack.addArrangedSubview(UILabel.studio(question.prompt, size: 14, weight: .semibold, lines: 0))
        if let answer = question.answer {
            let chosen = question.options.filter { answer.optionIds.contains($0.id) }.map(\.label).joined(separator: ", ")
            card.stack.addArrangedSubview(UILabel.studio("Yanıtlandı: \(chosen.isEmpty ? (answer.text ?? "") : chosen)", size: 12, color: IOSTheme.textSecondary))
        } else {
            let busy = model.busyQuestions.contains(message.id + question.questionId)
            let optionsStack = UIStackView()
            optionsStack.axis = .vertical
            optionsStack.alignment = .leading
            optionsStack.spacing = 6
            for opt in question.options {
                let pill = UIButton.studioPill(title: opt.label) { [weak self] in
                    guard let self else { return }
                    Task { await self.model.answer(message: message, question: question, optionId: opt.id) }
                }
                pill.isEnabled = !busy
                optionsStack.addArrangedSubview(pill)
            }
            card.stack.addArrangedSubview(optionsStack)
        }
        return card
    }

    private func makePlanCard(_ plan: Plan) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("\(plan.title) · \(plan.items.count) post", size: 15, weight: .bold))
        if !plan.summary.isEmpty {
            card.stack.addArrangedSubview(UILabel.studio(plan.summary, size: 13, color: IOSTheme.textSecondary, lines: 0))
        }
        for item in plan.items.prefix(4) {
            let dayStr = item.date.map(TurkishFormat.shortDay) ?? "—"
            card.stack.addArrangedSubview(UILabel.studio("\(dayStr) · \(item.title)", size: 13, color: IOSTheme.textPrimary))
        }
        if plan.items.count > 4 {
            card.stack.addArrangedSubview(UILabel.studio("+\(plan.items.count - 4) post daha", size: 12, color: IOSTheme.textTertiary))
        }
        if plan.status.isOpen {
            let busy = model.busyPlans.contains(plan.id)
            let acceptBtn = UIButton.studioPill(title: "Onayla ve üret", primary: true) { [weak self] in
                guard let self else { return }
                Task { await self.model.acceptAndGenerate(plan) }
            }
            acceptBtn.isEnabled = !busy
            let editBtn = UIButton.studioPill(title: "Düzenle") { [weak self] in
                self?.textField.placeholder = "Planda neyi değiştireyim?"
                self?.textField.becomeFirstResponder()
            }
            let actions = UIStackView(arrangedSubviews: [acceptBtn, editBtn, UIView()])
            actions.axis = .horizontal
            actions.spacing = 8
            card.stack.addArrangedSubview(actions)
        } else {
            let statusTxt = plan.status == .accepted ? "✓ Onaylandı ve üretime alındı" : "Reddedildi"
            card.stack.addArrangedSubview(UILabel.studio(statusTxt, size: 12, weight: .medium, color: IOSTheme.textSecondary))
        }
        return card
    }

    // MARK: - PHPickerViewController

    private func presentPhotoPicker() {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 4
        let picker = PHPickerViewController(configuration: config)
        picker.delegate = self
        present(picker, animated: true)
    }

    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        for item in results {
            guard item.itemProvider.canLoadObject(ofClass: UIImage.self) else { continue }
            let suggested = item.itemProvider.suggestedName ?? "fotograf"
            item.itemProvider.loadObject(ofClass: UIImage.self) { [weak self] obj, _ in
                guard let img = obj as? UIImage else { return }
                Task { @MainActor [weak self] in
                    self?.model.addPhoto(img, filename: "\(suggested).jpg")
                }
            }
        }
    }
}
