import StudioKit
import UIKit

/// Subscription usage and AI connections (the usage ring's sheet).
final class UsageSheetViewController: UIViewController {
    private unowned let app: IOSAppModel
    private let presence: @MainActor () -> WorkerPresence?
    private let stack = UIStackView.v([], spacing: 14)
    private var observation: IOSObservationToken?
    private var deciding: ClaudeLimitChoice?

    init(app: IOSAppModel, presence: @escaping @MainActor () -> WorkerPresence?) {
        self.app = app
        self.presence = presence
        super.init(nibName: nil, bundle: nil)
        title = "Kullanım ve bağlantılar"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.pin(to: view)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * IOSTheme.gutter),
        ])
        observation = observeIOS { [weak self] in self?.render() }
        Task { await app.loadAISpend() }
    }

    private func render() {
        stack.removeAllArranged()
        let presence = presence()
        if let limit = presence?.claude?.limit {
            stack.addArrangedSubview(limitCard(limit))
        }

        let usage = IOSCardView(padding: 16, spacing: 12)
        usage.stack.addArrangedSubview(UILabel.studio("Claude aboneliği", size: 17, weight: .semibold, style: .headline))
        if let windows = presence?.usage?.windows, !windows.isEmpty {
            for window in windows {
                let percent = window.effectivePercent
                let bar = UIProgressView(progressViewStyle: .default)
                bar.progress = Float(percent / 100)
                bar.progressTintColor = AssistantStatus.isWarning(percent) ? IOSTheme.accent : IOSTheme.ink
                bar.trackTintColor = IOSTheme.fill
                let title = UILabel.studio(AssistantStatus.windowTitle(window.kind), size: 15, weight: .medium, style: .subheadline)
                let used = UILabel.studio(AssistantStatus.usedText(window), size: 14, color: AssistantStatus.isWarning(percent) ? IOSTheme.accent : IOSTheme.textSecondary, style: .subheadline)
                used.font = IOSTheme.monoDigits(14)
                var rows: [UIView] = [UIStackView.h([title, UIView.spacer(), used], spacing: 8), bar]
                if let reset = window.resetsAt {
                    rows.append(UILabel.studio("Sıfırlanma: \(AssistantStatus.relative(reset))", size: 13, color: IOSTheme.textSecondary, style: .footnote))
                }
                usage.stack.addArrangedSubview(UIStackView.v(rows, spacing: 6))
            }
            if let observed = presence?.usage?.observedAt {
                usage.stack.addArrangedSubview(UILabel.studio("Güncellendi: \(AssistantStatus.relative(observed))", size: 12, color: IOSTheme.textTertiary, style: .caption1))
            }
        } else {
            usage.stack.addArrangedSubview(UILabel.studio("Mac henüz kullanım bildirmedi. Sohbette /usage yazarak sorabilirsin.", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        stack.addArrangedSubview(usage)

        stack.addArrangedSubview(spendCard())

        let connections = IOSCardView(padding: 16, spacing: 10)
        connections.stack.addArrangedSubview(row("Mac", AssistantStatus.macLine(presence)))
        connections.stack.addArrangedSubview(row("Claude", AssistantStatus.claudeLine(presence)))
        connections.stack.addArrangedSubview(row("Gemini", AssistantStatus.geminiLine(presence)))
        stack.addArrangedSubview(connections)

        let refresh = UIButton.studioPill(title: "Durumu yenile", kind: .secondary, image: "arrow.clockwise") { [weak self] in
            guard let self else { return }
            Task {
                _ = try? await self.app.dataService.claudeRefresh()
                _ = try? await self.app.dataService.geminiRefresh()
                Toast.show("Mac'ten durum istendi", in: self.view)
            }
        }
        stack.addArrangedSubview(UIStackView.h([refresh, UIView.spacer()], spacing: 0))
        if presence?.claude?.status == .signedOut {
            stack.addArrangedSubview(UILabel.studio("Claude girişi Mac'te yapılır: Studio → Ayarlar → Claude ile giriş yap.", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote))
        }
    }

    /// Claude's window is used up: when it resets and, in mode "Sor", the two answers.
    private func limitCard(_ limit: ClaudeLimitState) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UIStackView.h([
            IOSStatusDotView(color: IOSTheme.accent, size: 8),
            UILabel.studio("Claude sınırı doldu", size: 17, weight: .semibold, style: .headline),
            UIView.spacer(),
        ], spacing: 8))
        var lines = ["Sıfırlanma: \(AssistantStatus.relative(limit.resetsAt))"]
        if limit.waiting > 0 { lines.append("\(limit.waiting) iş bekliyor") }
        if let decision = limit.decision {
            lines.append("Karar: \(decision.label)")
        } else if limit.mode != .ask {
            lines.append("Ayar: \(limit.mode.label)")
        }
        card.stack.addArrangedSubview(UILabel.studio(lines.joined(separator: " · "), size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        guard limit.needsDecision else { return card }
        let gemini = UIButton.studioPill(title: ClaudeLimitChoice.gemini.label, kind: .primary) { [weak self] in self?.decide(.gemini) }
        gemini.isEnabled = limit.geminiReady && deciding == nil
        gemini.configuration?.showsActivityIndicator = deciding == .gemini
        let wait = UIButton.studioPill(title: ClaudeLimitChoice.wait.label, kind: .secondary) { [weak self] in self?.decide(.wait) }
        wait.isEnabled = deciding == nil
        wait.configuration?.showsActivityIndicator = deciding == .wait
        card.stack.addArrangedSubview(UIStackView.h([gemini, wait, UIView.spacer()], spacing: 8))
        if !limit.geminiReady {
            card.stack.addArrangedSubview(UILabel.studio("Gemini anahtarı Mac'te eklenmediği için yalnızca beklenebilir.", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote))
        }
        return card
    }

    private func decide(_ choice: ClaudeLimitChoice) {
        deciding = choice
        render()
        Task {
            let problem = await app.decideClaudeLimit(choice)
            deciding = nil
            render()
            if let problem { presentError(problem) } else {
                Haptics.success()
                Toast.show(choice == .gemini ? "Gemini ile devam ediliyor" : "Sınır bekleniyor", in: view)
            }
        }
    }

    /// Paid AI this month (Gemini, OpenAI, ElevenLabs …) against the monthly budget.
    private func spendCard() -> UIView {
        let card = IOSCardView(padding: 16, spacing: 10)
        card.stack.addArrangedSubview(UILabel.studio("Ücretli yapay zekâ", size: 17, weight: .semibold, style: .headline))
        guard let spend = app.aiSpend else {
            let text = app.aiSpendError ?? "Yükleniyor…"
            card.stack.addArrangedSubview(UILabel.studio(text, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
            return card
        }
        card.stack.addArrangedSubview(row("Bu ay", spend.budgetLine))
        if spend.budget.monthlyUsd != nil {
            let bar = UIProgressView(progressViewStyle: .default)
            bar.progress = Float(min(100, spend.budget.usedPercent ?? 0) / 100)
            bar.progressTintColor = spend.budget.warning ? IOSTheme.accent : IOSTheme.ink
            bar.trackTintColor = IOSTheme.fill
            card.stack.addArrangedSubview(bar)
        }
        card.stack.addArrangedSubview(row("Bugün", AISpendSummary.usd(spend.today.costUsd)))
        for line in spend.providerLines {
            card.stack.addArrangedSubview(row(line.name, line.text))
        }
        if spend.budget.exhausted == true {
            card.stack.addArrangedSubview(UILabel.studio("Bütçe doldu: ücretli çağrılar ay sonuna kadar durdu.", size: 13, color: IOSTheme.accent, lines: 0, style: .footnote))
        } else if spend.budget.warning {
            card.stack.addArrangedSubview(UILabel.studio("Aylık bütçenin %80'i geçildi.", size: 13, color: IOSTheme.accent, lines: 0, style: .footnote))
        }
        if spend.month.unpricedCalls > 0 {
            card.stack.addArrangedSubview(UILabel.studio("\(spend.month.unpricedCalls) çağrının fiyatı bilinmiyor; toplama katılmadı.", size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1))
        }
        card.stack.addArrangedSubview(UILabel.studio("Bütçe Mac'teki Studio'da ayarlanır.", size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1))
        return card
    }

    private func row(_ title: String, _ value: String) -> UIView {
        let titleLabel = UILabel.studio(title, size: 15, weight: .medium, style: .subheadline)
        titleLabel.widthAnchor.constraint(equalToConstant: 84).isActive = true
        let valueLabel = UILabel.studio(value, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline)
        return UIStackView.h([titleLabel, valueLabel], spacing: 10, alignment: .firstBaseline)
    }
}

/// Large preview of a conversation image with its alias: rename, mention, share.
final class AliasPreviewViewController: UIViewController {
    private let model: IOSConversationModel
    private let assetId: EntityID
    private var alias: ConversationAlias?
    private let zoom = ZoomableView()
    private let nameLabel = UILabel.studio("", size: 17, weight: .semibold, style: .headline)

    init(model: IOSConversationModel, assetId: EntityID, alias: ConversationAlias?) {
        self.model = model
        self.assetId = assetId
        self.alias = alias
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.rightBarButtonItem = UIBarButtonItem(systemItem: .close, primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })

        let image = IOSAssetImageView(store: model.app.images, assetId: assetId, contentMode: .scaleAspectFit)
        image.backgroundColor = .clear
        zoom.translatesAutoresizingMaskIntoConstraints = false
        zoom.content.addSubview(image)
        image.pin(to: zoom.content)
        if let w = alias?.width, let h = alias?.height, h > 0 { zoom.aspect = CGFloat(w) / CGFloat(h) }

        nameLabel.text = alias.map { "@\($0.alias)" } ?? "Görsel"
        var actions: [UIView] = []
        if alias != nil {
            actions.append(UIButton.studioPill(title: "Mesaja ekle", kind: .secondary, image: "at") { [weak self] in
                guard let self, let alias = self.alias else { return }
                self.model.composer.appendMention(alias.alias)
                self.dismiss(animated: true)
            })
            actions.append(UIButton.studioPill(title: "Yeniden adlandır", kind: .secondary, image: "pencil") { [weak self] in self?.rename() })
        }
        actions.append(UIButton.studioPill(title: "Paylaş", kind: .secondary, image: "square.and.arrow.up") { [weak self] in self?.share() })
        actions.append(UIView.spacer())
        let actionRow = UIScrollView()
        actionRow.translatesAutoresizingMaskIntoConstraints = false
        actionRow.showsHorizontalScrollIndicator = false
        let row = UIStackView.h(actions, spacing: 8)
        actionRow.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: actionRow.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: actionRow.contentLayoutGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: actionRow.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: actionRow.contentLayoutGuide.bottomAnchor),
            row.heightAnchor.constraint(equalTo: actionRow.frameLayoutGuide.heightAnchor),
            actionRow.heightAnchor.constraint(equalToConstant: 44),
        ])
        let stack = UIStackView.v([zoom, nameLabel, actionRow], spacing: 12)
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -12),
        ])
    }

    private func rename() {
        guard let alias else { return }
        prompt("Takma ad", message: "Eski ad bu sohbette kullanılmaya devam eder.", text: alias.alias) { [weak self] name in
            guard let self else { return }
            Task {
                if let problem = await self.model.renameAlias(alias, to: name) {
                    self.presentError(problem)
                } else {
                    let normalized = ImageAlias.normalize(name)
                    self.alias?.alias = normalized
                    self.nameLabel.text = "@\(normalized)"
                    Haptics.success()
                }
            }
        }
    }

    private func share() {
        Task {
            guard let data = await model.app.images.data(assetId), let image = UIImage(data: data) else {
                presentError("Görsel indirilemedi.")
                return
            }
            FileSharing.share([image], from: self)
        }
    }
}
