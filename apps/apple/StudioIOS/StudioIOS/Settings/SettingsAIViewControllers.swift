import StudioKit
import UIKit

/// Ayarlar → Yapay zekâ: default model and effort (this iPhone and the Mac), Claude and what
/// happens at its limit, Gemini and its key, the other providers and the OpenAI key.
final class SettingsAIViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Yapay zekâ")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async {
        async let host: Void = store.loadHost()
        async let keys: Void = store.loadAIKeys()
        async let spend: Void = app.loadAISpend()
        _ = await (host, keys, spend)
    }

    private static func modelOptions(presence: WorkerPresence?) -> [(AgentModel, String)] {
        (AgentModel.claudeCases + AgentModel.geminiCases + AgentModel.otherCases).map { model in
            (model, AssistantStatus.isAvailable(model, presence: presence) ? model.displayName : "\(model.displayName) · şu an kullanılamıyor")
        }
    }

    override func buildSections() -> [SettingsSection] {
        let presence = app.presence
        var sections: [SettingsSection] = []

        // This iPhone's default for new chats.
        let phone = app.selection(for: nil)
        sections.append(SettingsSection("Bu iPhone'da yeni sohbetler", rows: [
            .menu("Model", value: phone.model.displayName, icon: "sparkle", Self.choiceMenu(Self.modelOptions(presence: presence), selected: phone.model) { [weak self] model in
                guard let self else { return }
                self.app.saveSelection(AgentSelection(model: model, effort: self.app.selection(for: nil).effort), for: nil)
                self.rebuild()
            }),
            .menu("Efor", value: phone.effort.displayName, icon: "dial.medium", Self.choiceMenu(AgentEffort.knownCases.map { ($0, $0.displayName) }, selected: phone.effort) { [weak self] effort in
                guard let self else { return }
                self.app.saveSelection(AgentSelection(model: self.app.selection(for: nil).model, effort: effort), for: nil)
                self.rebuild()
            }),
        ]))

        // The Mac's default (desktop-settings.json through the bridge).
        let values = store.hostValues
        let macModel = values?.defaultModel.flatMap(AgentModel.init(rawValue:))
        let macEffort = values?.defaultEffort.flatMap(AgentEffort.init(rawValue:))
        let canChangeMac = store.canChange && values != nil
        sections.append(SettingsSection(
            "Mac'te yeni sohbetler",
            footer: store.hostError ?? "Mac'teki Studio yeni sohbetleri bu modelle başlatır; sohbette değiştirilebilir.",
            rows: [
                .menu("Model", value: macModel?.displayName ?? "Varsayılan", icon: "laptopcomputer", enabled: canChangeMac, Self.choiceMenu(Self.modelOptions(presence: presence), selected: macModel) { [weak self] model in
                    self?.run { try await self?.store.changeHost(values: HostSettingsPatch(defaultModel: model)) }
                }),
                .menu("Efor", value: macEffort?.displayName ?? "Varsayılan", icon: "dial.medium", enabled: canChangeMac, Self.choiceMenu(AgentEffort.knownCases.map { ($0, $0.displayName) }, selected: macEffort) { [weak self] effort in
                    self?.run { try await self?.store.changeHost(values: HostSettingsPatch(defaultEffort: effort)) }
                }),
            ]))

        // Claude
        let limit = app.aiPreferences?.claudeLimit ?? .ask
        sections.append(SettingsSection("Claude", footer: "Opus, Sonnet ve Haiku Mac'teki Claude Code girişiyle çalışır; giriş Mac'te yapılır.", rows: [
            .info("Claude Code", detail: AssistantStatus.claudeLine(presence), icon: "sparkle", tint: presence?.claude?.status == .signedIn ? IOSTheme.accent : nil),
            .menu("Sınır dolunca", detail: "Claude'un kullanım sınırı dolunca işler ne yapsın.", value: limit.label, icon: "hourglass", enabled: store.canChange,
                  Self.choiceMenu(ClaudeLimitMode.knownCases.map { ($0, $0.label) }, selected: limit) { [weak self] mode in
                      self?.run { try await self?.store.setAIPreferences(AIPreferencesPut(claudeLimit: mode)) }
                  }),
            .action("Durumu yenile", icon: "arrow.clockwise", enabled: store.canChange) { [weak self] in
                guard let self else { return }
                self.run("Mac'ten durum istendi") {
                    _ = try await self.app.dataService.claudeRefresh()
                    _ = try await self.app.dataService.geminiRefresh()
                }
            },
        ]))

        // Gemini
        sections.append(SettingsSection("Gemini", footer: "Anahtar Mac'teki kasada şifreli saklanır; telefona geri gönderilmez.", rows: [
            .info("Gemini", detail: AssistantStatus.geminiLine(presence), icon: "sparkles", tint: presence?.gemini?.status == .ready ? IOSTheme.accent : nil),
            keyRow(.gemini),
        ]))

        // Codex, OpenAI, Antigravity
        var others: [SettingsRow] = []
        for provider in [AIProvider.codex, .antigravity] {
            let row = presence?.providers?.first { $0.provider == provider }
            let title = provider == .codex ? "Codex (ChatGPT)" : "Antigravity"
            others.append(.info(title, detail: Self.providerLine(row, online: presence?.online == true), icon: provider == .codex ? "terminal" : "airplane", tint: row?.state == .ready ? IOSTheme.accent : nil))
        }
        others.insert(keyRow(.openai), at: 1)
        sections.append(SettingsSection("Diğer sağlayıcılar", footer: "Codex ve Antigravity'ye giriş Mac'te yapılır.", rows: others))
        return sections
    }

    private func keyRow(_ provider: AIKeyProvider) -> SettingsRow {
        let state = store.aiKeys?.items.first { $0.provider == provider }
        let warn = state?.valid == false
        return .navigate(provider.displayName, value: state?.statusText ?? "…", icon: "key", tint: warn ? IOSTheme.accent : nil) { [weak self] in
            guard let self else { return }
            self.push(SettingsAIKeyViewController(app: self.app, provider: provider))
        }
    }

    static func providerLine(_ row: AIProviderStatus?, online: Bool) -> String {
        guard let row else { return online ? "Durum bekleniyor" : "Mac çevrimdışı" }
        let base: String = switch row.state {
        case .ready: row.account.map { "Hazır · \($0)" } ?? "Hazır"
        case .signedOut: "Giriş yapılmadı (Mac'te giriş yap)"
        case .signingIn: "Mac'te giriş bekleniyor"
        case .notInstalled: "Mac'te kurulu değil"
        case .notConfigured: "Yapılandırılmadı"
        case .error, .unknown: row.detail ?? "Durum okunamadı"
        }
        return [base, row.cliVersion.map { "CLI \($0)" }].compactMap { $0 }.joined(separator: " · ")
    }
}

/// One AI provider key: whether it is stored (never the key), the last check, and paste a new
/// one / check again / remove.
final class SettingsAIKeyViewController: SettingsTableViewController {
    private let provider: AIKeyProvider

    init(app: IOSAppModel, provider: AIKeyProvider) {
        self.provider = provider
        super.init(app: app, title: provider.displayName)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await store.loadAIKeys() }

    override func buildSections() -> [SettingsSection] {
        let state = store.aiKeys?.items.first { $0.provider == provider }
        let configured = state?.configured == true
        let vaultReady = store.aiKeys?.vaultReady ?? true
        var status: [SettingsRow] = [.info("Durum", value: state?.statusText ?? "…")]
        if let detail = state?.detail, !detail.isEmpty { status.append(.info("Son denetim", detail: detail)) }
        if let checked = state?.checkedAt { status.append(.info("Denetlendi", value: AssistantStatus.relative(checked))) }
        if let models = state?.models, !models.isEmpty { status.append(.info("Modeller", value: "\(models.count)")) }
        var actions: [SettingsRow] = [
            .action(configured ? "Yeni anahtar yapıştır" : "Anahtarı yapıştır", icon: "doc.on.clipboard", enabled: store.canChange && vaultReady) { [weak self] in
                self?.paste()
            },
        ]
        if configured {
            actions.append(.action("Yeniden denetle", icon: "checkmark.shield", enabled: store.canChange) { [weak self] in
                guard let self else { return }
                self.run("Denetlendi") { try await self.store.checkAIKey(self.provider) }
            })
        }
        if let page = provider.keyPage {
            actions.append(.action("Anahtar al", icon: "arrow.up.right.square") { UIApplication.shared.open(page) })
        }
        var sections = [
            SettingsSection(footer: vaultReady ? "Anahtar kaydedilmeden önce sağlayıcıda denetlenir (ücretsiz). Mac'teki kasada şifreli durur; telefona geri gönderilmez." : "Mac'in kasa anahtarı yok; anahtar kaydedilemiyor.", rows: status),
            SettingsSection(rows: actions),
        ]
        if configured {
            sections.append(SettingsSection(rows: [
                .action("Anahtarı sil", icon: "trash", destructive: true, enabled: store.canChange) { [weak self] in
                    guard let self else { return }
                    self.confirm("\(self.provider.displayName) silinsin mi?", message: "Worker bundan sonra bu anahtarı kullanmaz (varsa depodaki .env'e döner).", action: "Sil") {
                        self.run("Silindi") { try await self.store.deleteAIKey(self.provider) }
                    }
                },
            ]))
        }
        return sections
    }

    private func paste() {
        enterText(title: provider.displayName, message: "Anahtar bir kez gönderilir ve Mac'te saklanır; burada bir daha gösterilmez.", placeholder: "Anahtarı yapıştır", secure: true) { [weak self] key in
            guard let self else { return }
            try await self.store.setAIKey(self.provider, key: key)
        }
    }
}

/// Ayarlar → Kullanım: Claude's windows, the paid AI spend this month and the budget.
final class SettingsUsageViewController: SettingsTableViewController {
    init(app: IOSAppModel) {
        super.init(app: app, title: "Kullanım")
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func refresh() async { await app.loadAISpend() }

    override func buildSections() -> [SettingsSection] {
        let presence = app.presence
        var sections: [SettingsSection] = []

        var claude: [SettingsRow] = []
        for window in presence?.usage?.windows ?? [] {
            let reset = window.resetsAt.map { "Sıfırlanma \(AssistantStatus.relative($0))" }
            claude.append(.info(AssistantStatus.windowTitle(window.kind), detail: reset, value: AssistantStatus.usedText(window),
                                icon: "gauge.with.dots.needle.50percent", tint: AssistantStatus.isWarning(window.effectivePercent) ? IOSTheme.accent : nil))
        }
        if claude.isEmpty { claude.append(.info("Henüz bildirilmedi", detail: "Claude Code'un 5 saatlik ve haftalık kullanımı Mac'ten gelir.")) }
        sections.append(SettingsSection("Claude aboneliği", rows: claude))

        let spend = app.aiSpend
        var money: [SettingsRow] = []
        if let spend {
            money.append(.info("Bu ay", value: AISpendSummary.usd(spend.month.costUsd)))
            money.append(.info("Bugün", value: AISpendSummary.usd(spend.today.costUsd)))
            for line in spend.providerLines { money.append(.info(line.name, value: line.text)) }
        } else {
            money.append(.info(app.aiSpendError ?? "Okunuyor…"))
        }
        sections.append(SettingsSection("Yapay zekâ harcaması", footer: "Gemini, OpenAI ve ElevenLabs çağrılarının tahmini tutarı (fiyat tablosuna göre, USD).", rows: money))

        let prefs = app.aiPreferences
        let budget = prefs?.monthlyBudgetUsd
        sections.append(SettingsSection("Bütçe", footer: spend?.budget.exhausted == true ? "Bütçe doldu: ücretli çağrılar yapılmıyor." : "Toplam aylık bütçe %80'de uyarır.", rows: [
            .navigate("Aylık bütçe", value: budget.map { AISpendSummary.usd($0) } ?? "Yok", icon: "dollarsign.circle", enabled: store.canChange) { [weak self] in
                self?.editBudget(budget)
            },
            .toggle("Bütçe dolunca dur", detail: "Açıkken aylık bütçe dolunca ücretli yapay zekâ çağrıları yapılmaz.", isOn: prefs?.stopAtBudget ?? false, enabled: store.canChange) { [weak self] on in
                self?.run { try await self?.store.setAIPreferences(AIPreferencesPut(stopAtBudget: on)) }
            },
            .toggle("Görsellere yapay zekâ açıklaması", detail: "Görseller Mac'te ücretsiz etiketlenir. Açıkken Gemini her yeni görsele kısa bir açıklama da yazar (ücretli, bütçeyi aşmaz).", isOn: prefs?.mediaCaptions ?? false, enabled: store.canChange) { [weak self] on in
                self?.run { try await self?.store.setAIPreferences(AIPreferencesPut(mediaCaptions: on)) }
            },
        ]))
        sections.append(SettingsSection(footer: "Gemini API kalan krediyi bildirmez; AI Studio faturalandırma sayfasından bakılır.", rows: [
            .action("Kalan kredi (AI Studio)", icon: "arrow.up.right.square") {
                if let url = URL(string: "https://aistudio.google.com/usage") { UIApplication.shared.open(url) }
            },
        ]))
        return sections
    }

    private func editBudget(_ current: Double?) {
        let alert = UIAlertController(title: "Aylık bütçe (USD)", message: "Gemini, OpenAI ve ElevenLabs için toplam.", preferredStyle: .alert)
        alert.addTextField { field in
            field.keyboardType = .decimalPad
            field.placeholder = "20"
            field.text = current.map { String(format: "%g", $0) }
        }
        alert.addAction(UIAlertAction(title: "Vazgeç", style: .cancel))
        if current != nil {
            alert.addAction(UIAlertAction(title: "Bütçeyi kaldır", style: .destructive) { [weak self] _ in
                self?.run("Bütçe kaldırıldı") { try await self?.store.setAIPreferences(AIPreferencesPut(clearBudget: true)) }
            })
        }
        alert.addAction(UIAlertAction(title: "Kaydet", style: .default) { [weak self, weak alert] _ in
            let raw = (alert?.textFields?.first?.text ?? "").replacingOccurrences(of: ",", with: ".").trimmingCharacters(in: .whitespaces)
            guard let value = Double(raw), value >= 0, value <= 1_000_000 else {
                self?.presentError("Bir tutar yaz (ör. 20).")
                return
            }
            self?.run("Bütçe kaydedildi") { try await self?.store.setAIPreferences(AIPreferencesPut(monthlyBudgetUsd: value)) }
        })
        present(alert, animated: true)
    }
}
