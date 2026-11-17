import AppKit
import StudioKit

/// First-run sheet: Hoş geldin → Claude hesabı → Mac sunucusu → İlk marka → Hazır.
/// Return triggers the primary action, Esc skips (resumable from Yardım).
final class OnboardingSheetController: NSViewController {
    private let model: OnboardingModel
    private unowned let app: AppModel
    private weak var host: LocalHost?

    private let stepDots = BrandUI.hstack([], spacing: 6)
    private let stepLabel = NSTextField.styledLabel("", font: Theme.smallFont, color: Theme.textTertiary)
    private let content = NSView()
    private var backButton: PillButton!
    private var skipButton: PillButton!
    private var secondaryButton: PillButton!
    private var primaryButton: PillButton!
    private var stepViews: [OnboardingStep: NSView] = [:]
    private weak var shown: NSView?
    private var observation: ObservationToken?

    // Step widgets that change.
    private let claudeStatus = BrandUI.status("", color: Theme.textTertiary)
    private let claudeDetail = BrandUI.note()
    private let claudeError = BrandUI.note()
    private var claudeLoginButton: PillButton!
    private var claudeRecheckButton: PillButton!
    private var claudeOpenLinkButton: PillButton!

    private let serverStatus = BrandUI.status("", color: Theme.textTertiary)
    private let serverDetail = BrandUI.note()
    private let workerStatus = BrandUI.status("", color: Theme.textTertiary)
    private let lanStatus = BrandUI.status("", color: Theme.textTertiary)
    private let lanDetail = BrandUI.note()
    private var restartButton: PillButton!

    private let brandNameField = BrandUI.field("Örn. MTM Agro")
    private let brandSlugField = BrandUI.field("mtm-agro")
    private let instagramField = BrandUI.field("@kullaniciadi (isteğe bağlı)")
    private var languagePopUp: ClosurePopUp!
    private let brandProblem = BrandUI.note()
    private let existingBrandNote = BrandUI.note()
    private let brandForm = BrandUI.vstack(spacing: 8)
    private var handlers: [FieldHandler] = []

    private let doneList = BrandUI.vstack(spacing: 10)

    init(app: AppModel, host: LocalHost?) {
        self.app = app
        model = app.onboarding
        self.host = host
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ReturnKeyRootView()
        root.onReturn = { [weak self] in
            guard let self, self.primaryButton.isEnabled else { return false }
            self.primaryTapped()
            return true
        }
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        for _ in OnboardingStep.allCases { stepDots.addArrangedSubview(StatusDotView(color: Theme.fillStrong, size: 7)) }
        let top = BrandUI.hstack([stepDots, BrandUI.spacer(), stepLabel])

        content.translatesAutoresizingMaskIntoConstraints = false

        backButton = PillButton(title: "Geri", kind: .secondary, height: 30) { [weak self] in self?.model.goBack() }
        skipButton = PillButton(title: "Şimdilik geç", kind: .outline, height: 30) { [weak self] in self?.skip() }
        skipButton.toolTip = "Sonra Yardım → Başlangıç rehberi ile kaldığın yerden devam edebilirsin."
        secondaryButton = PillButton(title: "", kind: .secondary, height: 30) { [weak self] in self?.secondaryTapped() }
        primaryButton = PillButton(title: "", kind: .primary, height: 30) { [weak self] in self?.primaryTapped() }
        let footer = BrandUI.hstack([backButton, skipButton, BrandUI.spacer(), secondaryButton, primaryButton], spacing: 8)

        root.addSubview(top)
        root.addSubview(content)
        root.addSubview(footer)
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 560),
            root.heightAnchor.constraint(equalToConstant: 470),
            top.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            top.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
            top.topAnchor.constraint(equalTo: root.topAnchor, constant: 22),
            content.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 28),
            content.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -28),
            content.topAnchor.constraint(equalTo: top.bottomAnchor, constant: 22),
            content.bottomAnchor.constraint(equalTo: footer.topAnchor, constant: -16),
            footer.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 24),
            footer.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -24),
            footer.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -20),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in self?.render() }
        Task { await model.refreshClaudeStatus() }
    }

    override func cancelOperation(_ sender: Any?) { skip() }


    private func skip() {
        model.skip()
    }

    // MARK: Render

    private func render() {
        let step = model.step
        for (index, dot) in stepDots.arrangedSubviews.enumerated() {
            (dot as? StatusDotView)?.color = index == step.index ? Theme.ink : (index < step.index ? Theme.textTertiary : Theme.fillStrong)
        }
        stepLabel.stringValue = "\(step.index + 1) / \(OnboardingStep.allCases.count) · \(step.title)"
        show(step)

        backButton.isHidden = step == .welcome || step == .done
        skipButton.isHidden = step == .done
        secondaryButton.isHidden = true
        primaryButton.isEnabled = true
        primaryButton.showsSpinner = false

        switch step {
        case .welcome:
            primaryButton.title = "Başla"
            primaryButton.kind = .primary
        case .claude:
            renderClaude()
            primaryButton.title = model.isClaudeReady ? "Devam" : "Sonra yaparım"
            primaryButton.kind = model.isClaudeReady ? .primary : .secondary
        case .server:
            renderServer()
            primaryButton.title = "Devam"
            primaryButton.kind = .primary
        case .brand:
            renderBrand()
            if let existing = model.existingBrand, model.createdBrandId == nil, model.brandName.isEmpty {
                primaryButton.title = "Devam"
                primaryButton.kind = .primary
                existingBrandNote.stringValue = "\(existing.name) markan hazır. Yeni bir marka eklemek istersen aşağıyı doldur; istemezsen devam et."
            } else {
                primaryButton.title = "Markayı oluştur"
                primaryButton.kind = .primary
                primaryButton.isEnabled = model.brandProblem == nil && !model.isCreatingBrand
                primaryButton.showsSpinner = model.isCreatingBrand
            }
        case .done:
            renderDone()
            primaryButton.kind = .primary
            if model.existingBrand != nil {
                secondaryButton.isHidden = false
                secondaryButton.title = "Bitir"
                primaryButton.title = "Marka kitini hazırla"
            } else {
                primaryButton.title = "Bitir"
            }
        }
    }

    private func primaryTapped() {
        view.window?.makeFirstResponder(nil)
        switch model.step {
        case .welcome, .claude, .server:
            model.advance()
        case .brand:
            if model.existingBrand != nil, model.createdBrandId == nil, model.brandName.isEmpty {
                model.advance()
            } else {
                Task { await model.createBrand() }
            }
        case .done:
            if model.existingBrand != nil { model.openBrandKit() } else { model.finish() }
        }
    }

    private func secondaryTapped() {
        if model.step == .done { model.finish() }
    }

    private func show(_ step: OnboardingStep) {
        let next: NSView
        if let existing = stepViews[step] {
            next = existing
        } else {
            next = switch step {
            case .welcome: makeWelcome()
            case .claude: makeClaude()
            case .server: makeServer()
            case .brand: makeBrand()
            case .done: makeDone()
            }
            stepViews[step] = next
        }
        guard shown !== next else { return }
        shown?.removeFromSuperview()
        next.translatesAutoresizingMaskIntoConstraints = false
        content.addSubview(next)
        NSLayoutConstraint.activate([
            next.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            next.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            next.topAnchor.constraint(equalTo: content.topAnchor),
        ])
        shown = next
        if step == .brand { DispatchQueue.main.async { [weak self] in self?.view.window?.makeFirstResponder(self?.brandNameField) } }
    }

    private func page(title: String, text: String, extra: [NSView]) -> NSView {
        let stack = BrandUI.vstack(spacing: 12)
        stack.addArrangedSubview(BrandUI.title(title, size: 22))
        BrandUI.addFull(BrandUI.note(text), to: stack)
        if let last = stack.arrangedSubviews.last { stack.setCustomSpacing(20, after: last) }
        for view in extra { BrandUI.addFull(view, to: stack) }
        return stack
    }

    // MARK: Welcome

    private func makeWelcome() -> NSView {
        let items: [(String, String)] = [
            ("person.crop.circle.badge.checkmark", "Claude hesabını bağla: içerikleri Mac'indeki Claude aboneliğinle üretirsin."),
            ("laptopcomputer.and.iphone", "Veriler ve üretim bu Mac'te; iPhone'unu bir QR kodla bağlarsın."),
            ("square.stack.3d.up", "İlk markanı ekle: örnek postlardan marka profilini çıkarırsın."),
        ]
        let rows = items.map { symbol, text -> NSView in
            let icon = NSImageView(image: NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(.init(pointSize: 15, weight: .regular)) ?? NSImage())
            icon.contentTintColor = Theme.textSecondary
            icon.translatesAutoresizingMaskIntoConstraints = false
            icon.widthAnchor.constraint(equalToConstant: 22).isActive = true
            let label = NSTextField.styledLabel(text, font: Theme.rowFont, color: Theme.textPrimary, wraps: true)
            label.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
            return BrandUI.hstack([icon, label], spacing: 12, align: .top)
        }
        return page(title: "Studio'ya hoş geldin", text: "Birkaç adımda hazır olacağız. İstediğin adımı geçebilir, sonra Yardım menüsünden kaldığın yerden devam edebilirsin.", extra: rows)
    }

    // MARK: Claude

    private func makeClaude() -> NSView {
        claudeLoginButton = PillButton(title: "Claude'a giriş yap", kind: .primary, height: 30) { [weak self] in
            guard let self else { return }
            // While the browser step waits, the same button stops waiting (the owner closed it).
            if self.model.isSigningIn { self.model.cancelClaudeLogin() } else { Task { await self.model.startClaudeLogin() } }
        }
        claudeRecheckButton = PillButton(title: "Durumu yenile", kind: .secondary, height: 30) { [weak self] in
            guard let self else { return }
            Task { await self.model.recheckClaude() }
        }
        claudeOpenLinkButton = PillButton(title: "Giriş sayfasını aç", kind: .outline, height: 30) { [weak self] in
            guard let raw = self?.model.claude?.loginUrl, let url = URL(string: raw) else { return }
            NSWorkspace.shared.open(url)
        }
        claudeError.textColor = .systemRed
        let (card, stack) = BrandUI.card(spacing: 8)
        stack.addArrangedSubview(claudeStatus)
        BrandUI.addFull(claudeDetail, to: stack)
        return page(
            title: "Claude hesabı",
            text: "Studio içerikleri bu Mac'teki Claude Code ile, senin aboneliğinle üretir. Giriş tarayıcıda açılır; şifren Studio'ya gelmez.",
            extra: [card, BrandUI.hstack([claudeLoginButton, claudeRecheckButton, claudeOpenLinkButton]), claudeError]
        )
    }

    private func renderClaude() {
        let claude = model.claude
        let online = model.workerOnline
        let (text, color): (String, NSColor) = {
            guard let claude else {
                return online ? ("Durum okunuyor…", Theme.textTertiary) : ("Arka plan hazır değil", Theme.textTertiary)
            }
            switch claude.status {
            case .signedIn:
                let who = [claude.email, claude.plan].compactMap { $0 }.joined(separator: " · ")
                return (who.isEmpty ? "Giriş yapıldı" : "Giriş yapıldı: \(who)", .systemGreen)
            case .signingIn: return ("Tarayıcıda giriş bekleniyor…", Theme.accent)
            case .signedOut: return ("Giriş yapılmadı", Theme.accent)
            case .notInstalled: return ("Claude Code bu Mac'te kurulu değil", .systemRed)
            case .error, .unknown: return ("Durum okunamadı", .systemRed)
            }
        }()
        (claudeStatus.arrangedSubviews.first as? StatusDotView)?.color = color
        (claudeStatus.arrangedSubviews.last as? NSTextField)?.stringValue = text
        var details: [String] = []
        if let cli = claude?.cliVersion { details.append("Claude Code \(cli)") }
        if let detail = claude?.detail, !detail.isEmpty, claude?.status != .signedIn { details.append(detail) }
        if claude?.status == .notInstalled { details.append("Kurulum: claude.com/claude-code, sonra Durumu yenile.") }
        if !online { details.append("Mac sunucusu çalışınca durum burada görünür (sonraki adım).") }
        claudeDetail.stringValue = details.joined(separator: " · ")
        claudeDetail.isHidden = details.isEmpty
        claudeError.stringValue = model.claudeError ?? ""
        claudeError.isHidden = model.claudeError == nil

        let signedIn = claude?.status == .signedIn
        claudeLoginButton.title = signedIn ? "Hesabı değiştir" : (model.isSigningIn ? "Beklemeyi bırak" : "Claude'a giriş yap")
        claudeLoginButton.kind = signedIn || model.isSigningIn ? .secondary : .primary
        claudeLoginButton.showsSpinner = model.isSigningIn
        claudeLoginButton.toolTip = model.isSigningIn ? "Tarayıcıdaki giriş bekleniyor; vazgeçtiysen bekleme burada durur." : nil
        claudeLoginButton.isEnabled = model.isSigningIn || (online && claude?.status != .notInstalled)
        claudeRecheckButton.isEnabled = online && !model.isRefreshingClaude
        claudeRecheckButton.showsSpinner = model.isRefreshingClaude
        claudeOpenLinkButton.isHidden = (claude?.loginUrl ?? "").isEmpty || signedIn
    }

    // MARK: Server

    private func makeServer() -> NSView {
        restartButton = PillButton(title: "Yeniden başlat", kind: .secondary, height: 28) { [weak self] in
            guard let host = self?.host else { return }
            Task { await host.restart() }
        }
        let (card, stack) = BrandUI.card(spacing: 8)
        stack.addArrangedSubview(serverStatus)
        BrandUI.addFull(serverDetail, to: stack)
        stack.addArrangedSubview(workerStatus)
        stack.addArrangedSubview(lanStatus)
        BrandUI.addFull(lanDetail, to: stack)
        let pairing = PhonePairingCardView(model: app.phonePairing, qrSize: 148)
        return page(
            title: "Mac ve iPhone",
            text: "Veriler, üretim ve yayın bu Mac'te çalışır. iPhone'dan da kullanmak için kodu okut; istersen bu adımı geçip sonra Ayarlar → Cihazlar'dan bağlarsın.",
            extra: [card, BrandUI.hstack([restartButton, BrandUI.spacer()]), pairing]
        )
    }

    private func renderServer() {
        let online = app.presence?.online == true
        if let host {
            let (text, color): (String, NSColor) = switch host.status {
            case .running: ("Studio bu Mac'te çalışıyor", .systemGreen)
            case .attached: ("Studio bu Mac'te çalışıyor", .systemGreen)
            case .starting: ("Studio hazırlanıyor…", Theme.accent)
            case .stopped: ("Studio durdu", Theme.textTertiary)
            case .error: ("Studio başlatılamadı", .systemRed)
            }
            (serverStatus.arrangedSubviews.first as? StatusDotView)?.color = color
            (serverStatus.arrangedSubviews.last as? NSTextField)?.stringValue = text
            // The technical step or error stays in the tooltip (and in Ayarlar → Gelişmiş).
            serverStatus.toolTip = switch host.status {
            case .starting(let what): what
            case .error(let message): message
            default: nil
            }
            serverDetail.stringValue = if case .error = host.status { "Yeniden başlatmayı dene; sürerse Ayarlar → Gelişmiş'teki hata kaydına bak." } else { "" }
            restartButton.isHidden = false
            let lan = host.lanURLs
            (lanStatus.arrangedSubviews.first as? StatusDotView)?.color = lan.isEmpty ? Theme.textTertiary : .systemGreen
            (lanStatus.arrangedSubviews.last as? NSTextField)?.stringValue = lan.isEmpty ? "iPhone şu an bağlanamaz" : "iPhone bağlanabilir"
            lanDetail.stringValue = lan.isEmpty
                ? "iPhone'un bağlanabilmesi için Ayarlar → Gelişmiş → Yerel ağdan erişim açık olmalı."
                : ""
        } else {
            (serverStatus.arrangedSubviews.first as? StatusDotView)?.color = Theme.textTertiary
            (serverStatus.arrangedSubviews.last as? NSTextField)?.stringValue = "Studio bu oturumda başka bir yere bağlı"
            serverDetail.stringValue = "Ayarlar → Gelişmiş'ten değiştirilebilir."
            restartButton.isHidden = true
            (lanStatus.arrangedSubviews.last as? NSTextField)?.stringValue = "iPhone bağlantısı bilinmiyor"
            lanDetail.stringValue = ""
        }
        (workerStatus.arrangedSubviews.first as? StatusDotView)?.color = online ? .systemGreen : Theme.textTertiary
        (workerStatus.arrangedSubviews.last as? NSTextField)?.stringValue = online ? "Hazır: işler hemen çalışır" : "Arka plan çalışmıyor: işler sırada bekler"
        lanDetail.isHidden = lanDetail.stringValue.isEmpty
        serverDetail.isHidden = serverDetail.stringValue.isEmpty
    }

    // MARK: Brand

    private func makeBrand() -> NSView {
        let nameHandler = FieldHandler(onChange: { [weak self] in self?.model.brandName = $0 }, onReturn: { [weak self] in self?.primaryTapped() })
        let slugHandler = FieldHandler(onChange: { [weak self] value in
            self?.model.slugEdited = !value.isEmpty
            self?.model.brandSlug = value
        }, onReturn: { [weak self] in self?.primaryTapped() })
        let instagramHandler = FieldHandler(onChange: { [weak self] in self?.model.instagramHandle = $0 }, onReturn: { [weak self] in self?.primaryTapped() })
        handlers += [nameHandler, slugHandler, instagramHandler]
        brandNameField.delegate = nameHandler
        brandSlugField.delegate = slugHandler
        instagramField.delegate = instagramHandler
        languagePopUp = ClosurePopUp(
            items: BrandLanguage.options.map { ($0.label, $0.tag as Any) },
            selected: { ($0 as? String) == "tr" },
            onPick: { [weak self] value in if let tag = value as? String { self?.model.brandLanguage = tag } }
        )
        brandProblem.textColor = .systemRed
        brandForm.addArrangedSubview(BrandUI.caption("Marka adı"))
        BrandUI.addFull(brandNameField, to: brandForm)
        brandForm.addArrangedSubview(BrandUI.caption("Kısa ad"))
        BrandUI.addFull(brandSlugField, to: brandForm)
        let languageColumn = BrandUI.vstack([BrandUI.caption("İçerik dili"), languagePopUp], spacing: 6)
        let instagramColumn = BrandUI.vstack([BrandUI.caption("Instagram"), instagramField], spacing: 6)
        instagramField.widthAnchor.constraint(equalTo: instagramColumn.widthAnchor).isActive = true
        BrandUI.addFull(BrandUI.hstack([languageColumn, instagramColumn], spacing: 16, align: .top), to: brandForm)
        BrandUI.addFull(brandProblem, to: brandForm)
        return page(
            title: "İlk marka",
            text: "Müşteri markasının adını yaz. Sonra marka kitine örnek postlarını, logosunu ve renklerini ekleyip profilini çıkaracaksın.",
            extra: [existingBrandNote, brandForm]
        )
    }

    private func renderBrand() {
        if brandSlugField.currentEditor() == nil || !model.slugEdited, brandSlugField.stringValue != model.brandSlug {
            brandSlugField.stringValue = model.brandSlug
        }
        existingBrandNote.isHidden = model.existingBrand == nil || model.createdBrandId != nil
        let touched = !model.brandName.isEmpty
        brandProblem.stringValue = model.brandError ?? (touched ? model.brandProblem ?? "" : "")
        brandProblem.isHidden = brandProblem.stringValue.isEmpty
    }

    // MARK: Done

    private func makeDone() -> NSView {
        page(title: "Hazırsın", text: "Bundan sonra Yeni sohbet'ten bir şey iste: \"Bu ayın postlarını planla\" gibi. Önce marka kitini doldurup profili çıkarmanı öneririz.", extra: [doneList])
    }

    private func renderDone() {
        doneList.arrangedSubviews.forEach { $0.removeFromSuperview() }
        let claudeOK = model.isClaudeReady
        let serverOK = host?.isUp ?? (app.presence?.online == true)
        let brand = model.existingBrand
        let rows: [(Bool, String)] = [
            (claudeOK, claudeOK ? "Claude hesabı bağlı" : "Claude girişi yapılmadı · Ayarlar → Yapay zekâ"),
            (serverOK, serverOK ? "Mac sunucusu çalışıyor" : "Mac sunucusu çalışmıyor · Ayarlar → Mac sunucusu"),
            (brand != nil, brand.map { "Marka: \($0.name)" } ?? "Marka eklenmedi · kenar çubuğunda Yeni marka"),
        ] + (model.brandError.map { [(false, "\($0) · Ayarlar → Hesaplar")] } ?? [])
        for (ok, text) in rows {
            let icon = NSImageView(image: NSImage(systemSymbolName: ok ? "checkmark.circle.fill" : "circle.dashed", accessibilityDescription: ok ? "Tamam" : "Eksik") ?? NSImage())
            icon.contentTintColor = ok ? Theme.ink : Theme.textTertiary
            let label = NSTextField.styledLabel(text, font: Theme.rowFont, color: ok ? Theme.textPrimary : Theme.textSecondary)
            BrandUI.addFull(BrandUI.hstack([icon, label, BrandUI.spacer()], spacing: 10), to: doneList)
        }
    }
}

/// Return / Enter with nothing focused runs the sheet's primary action (like a default button).
private final class ReturnKeyRootView: ThemedView {
    var onReturn: (() -> Bool)?

    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let plain = event.modifierFlags.intersection([.command, .option, .control, .shift]).isEmpty
        if plain, event.keyCode == 36 || event.keyCode == 76, onReturn?() == true { return true }
        return super.performKeyEquivalent(with: event)
    }
}
