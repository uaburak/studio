import StudioKit
import UIKit

// The six sections of a brand's page. Each builds its rows into `body` from the model; a change
// in the model renders the section again (BrandProfileViewController.render).

extension BrandProfileViewController {
    private var pageApp: IOSAppModel? { model.app }

    // MARK: Layout helpers

    /// A block of the page with the gutter around it.
    func addBlock(_ views: [UIView], spacing: CGFloat = 12, top: CGFloat = 20, bottom: CGFloat = 20) {
        let stack = UIStackView.v(views, spacing: spacing)
        body.addArrangedSubview(BrandUI.inset(stack, top: top, bottom: bottom))
    }

    func addHairline(inset: CGFloat = 0) {
        body.addArrangedSubview(BrandUI.hairline(inset: inset))
    }

    func addRows(_ rows: [UIView]) {
        for (index, row) in rows.enumerated() {
            body.addArrangedSubview(row)
            if index < rows.count - 1 { addHairline(inset: IOSTheme.gutter) }
        }
    }

    private func report(_ problem: String?, success: String? = nil) {
        if let problem {
            presentError(problem)
        } else if let success {
            Haptics.success()
            Toast.show(success, in: view)
        }
    }

    // MARK: - Genel

    func buildGeneral(_ brand: Brand, _ overview: BrandOverview) {
        let languageMenu = UIMenu(title: "İçerik dili", children: BrandLanguages.all.map { language in
            UIAction(title: language.label, state: language.tag == brand.defaultLanguage ? .on : .off) { [weak self] _ in
                guard let self, language.tag != brand.defaultLanguage else { return }
                Task { self.report(await self.model.updateBrand(BrandUpdate(defaultLanguage: language.tag)), success: "İçerik dili: \(language.label)") }
            }
        })
        addRows([
            BrandRowView(title: "Marka adı", detail: "Sohbetlerde ve kartlarda görünen ad.", value: brand.name) { [weak self] in self?.editBrand() },
            BrandRowView(title: "Kısa ad", detail: "Küçük harf, rakam ve tire (mtm-agro).", value: brand.slug) { [weak self] in self?.editBrand() },
            BrandRowView(title: "İçerik dili", detail: "Postlar bu dilde yazılır.", value: BrandLanguages.label(brand.defaultLanguage), menu: languageMenu),
            BrandRowView(title: "Seçili marka", detail: "Sohbet, Profil ve Takvim seçili markayla çalışır.", value: model.isCurrent ? "Bu marka" : "Başka marka", chevron: !model.isCurrent,
                         onTap: model.isCurrent || model.isArchived ? nil : { [weak self] in self?.selectBrand() }),
        ])
        addHairline()

        // The brand card's summary: what the posts are made with.
        var summary: [UIView] = [BrandUI.header("Özet", detail: "Onaylı profil varsa renkler ve yazı tipleri ondan, yoksa marka kitinden.")]
        if overview.swatches.isEmpty {
            summary.append(BrandUI.footnote("Renk yok."))
        } else {
            summary.append(swatchStrip(overview.swatches.map { ($0.name, $0.hex, nil) }, side: 40, onTap: nil))
        }
        if overview.fonts.isEmpty {
            summary.append(BrandUI.footnote("Yazı tipi yok; sistem fontu kullanılır."))
        } else {
            summary.append(UILabel.studio(overview.fonts.joined(separator: " · "), size: 15, lines: 0, style: .subheadline))
        }
        if let voice = overview.voice {
            summary.append(UILabel.studio(voice, size: 15, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        let accounts = BrandOverview.platformsSummary(overview.platforms)
        summary.append(UILabel.studio(accounts.text, size: 14, color: accounts.attention ? IOSTheme.accent : IOSTheme.textSecondary, lines: 0, style: .subheadline))
        addBlock(summary, spacing: 10)
        addHairline()

        let archived = brand.status == .archived
        let archive = BrandRowView(
            title: archived ? "Arşivden çıkar" : "Arşivle",
            detail: archived ? "Marka yeniden listelerde görünür." : "Marka silinmez; listelerden kalkar, sonra geri getirilebilir.",
            chevron: false) { [weak self] in self?.toggleArchive() }
        archive.titleLabel.textColor = archived ? IOSTheme.textPrimary : .systemRed
        body.addArrangedSubview(archive)
    }

    /// Colours as circles in a sideways strip.
    func swatchStrip(_ colors: [(name: String, hex: String, use: String?)], side: CGFloat, onTap: ((Int) -> Void)?) -> UIView {
        let views = colors.enumerated().map { index, color in
            SwatchView(name: color.name, hex: color.hex, use: color.use, side: side, onTap: onTap.map { tap in { tap(index) } })
        }
        return FlowView(views, spacing: 10)
    }

    // MARK: - Marka Kiti

    func buildKit(_ brand: Brand) {
        if let line = kitStatusLine() {
            addBlock([BrandUI.footnote(line.text, color: line.error ? .systemRed : IOSTheme.textSecondary)], top: 14, bottom: 0)
        }
        guard let kit = model.kit else {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            addBlock([model.kitError.map { BrandUI.footnote($0, color: .systemRed) } ?? spinner])
            return
        }
        buildLogos(kit)
        addHairline()
        buildColors(kit)
        addHairline()
        buildFonts(kit)
        addHairline()
        buildSamples(kit)
        addHairline()
        let notes = UILabel.studio(kit.notes.isEmpty ? "Not yok." : kit.notes, size: 15, color: kit.notes.isEmpty ? IOSTheme.textTertiary : IOSTheme.textPrimary, lines: 0, style: .subheadline)
        addBlock([
            BrandUI.header("Notlar", detail: "Markayı anlatan serbest notlar (hedef kitle, kaçınılacaklar …).",
                           action: BrandUI.smallPill("Düzenle", image: "pencil") { [weak self] in self?.editNotes() }),
            notes,
        ])
        addHairline()
        buildSkills(brand)
        addHairline()
        let checks = model.checks
        let on = CheckCatalog.all.filter { checks?.isEnabled($0.id) ?? true }.count
        let checksValue = checks.map { "\($0.strictness.label) · \(on)/\(CheckCatalog.all.count)" } ?? "Yükleniyor"
        let planning = model.planning
        let tags = planning?.effectiveTags.map(\.label) ?? []
        let categoriesOn = SpecialDayCategory.knownCases.filter { !(planning?.disabledCategories.contains($0) ?? false) }.count
        let daysValue = planning == nil ? "Yükleniyor" : (tags.isEmpty ? "Sektör yok" : tags.prefix(2).joined(separator: ", ") + (tags.count > 2 ? " +\(tags.count - 2)" : ""))
        addRows([
            BrandRowView(title: "Kontroller", detail: "Üretimden sonra çalışan denetimler, yasak kelimeler, otomatik düzeltme.", value: checksValue) { [weak self] in
                guard let self else { return }
                self.navigationController?.pushViewController(BrandChecksViewController(model: self.model), animated: true)
            },
            BrandRowView(title: "Özel günler", detail: "Plan ve Takvim'deki günler: sektörler, türler, bayram tarihleri · \(categoriesOn)/\(SpecialDayCategory.knownCases.count) tür açık", value: daysValue) { [weak self] in
                guard let self else { return }
                self.navigationController?.pushViewController(BrandSpecialDaysViewController(model: self.model), animated: true)
            },
        ])
    }

    private func kitStatusLine() -> (text: String, error: Bool)? {
        if model.uploads > 0 { return ("\(model.uploads) dosya yükleniyor…", false) }
        switch model.kitSave {
        case .idle: return nil
        case .saving: return ("Kaydediliyor…", false)
        case .saved: return ("Kaydedildi", false)
        case .failed(let message): return (message, true)
        }
    }

    // Logos

    private func buildLogos(_ kit: BrandKit) {
        let add = BrandUI.menuPill("Ekle", menu: UIMenu(children: [
            UIAction(title: "Fotoğraflar'dan", image: UIImage(systemName: "photo")) { [weak self] _ in self?.pickImages(kind: .logo, limit: 4) },
            UIAction(title: "Dosyalardan (PNG, SVG)", image: UIImage(systemName: "folder")) { [weak self] _ in self?.pickFiles(kind: .logo) },
        ]))
        var views: [UIView] = [BrandUI.header("Logolar", detail: "Açık ve koyu zemin için ayrı dosyalar varsa ikisini de ekle.", action: add)]
        if kit.logos.isEmpty {
            views.append(BrandUI.footnote("Logo yok.", color: IOSTheme.textTertiary))
            addBlock(views)
            return
        }
        addBlock(views, bottom: 12)
        let strip = UIScrollView()
        strip.translatesAutoresizingMaskIntoConstraints = false
        strip.showsHorizontalScrollIndicator = false
        let row = UIStackView.h(kit.logos.enumerated().map { logoTile($1, index: $0, all: kit.logos) }, spacing: 10, alignment: .top)
        strip.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: strip.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: strip.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: strip.contentLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            row.trailingAnchor.constraint(equalTo: strip.contentLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            strip.heightAnchor.constraint(equalTo: row.heightAnchor),
        ])
        body.addArrangedSubview(strip)
        body.addArrangedSubview(UIView.fixedSpacer(20))
    }

    /// A logo large on the background it is made for, its background under it; a tap opens it,
    /// a long press changes the background or removes it.
    private func logoTile(_ logo: BrandKitLogo, index: Int, all: [BrandKitLogo]) -> UIView {
        let dark = logo.background == .dark
        let tile = TileButton()
        tile.backgroundColor = dark ? UIColor(hex: 0x151515) : .white
        tile.layer.cornerRadius = 16
        tile.layer.cornerCurve = .continuous
        tile.clipsToBounds = true
        let image = IOSAssetImageView(store: pageApp?.images, assetId: logo.assetId, contentMode: .scaleAspectFit, displayWidth: 170)
        image.backgroundColor = .clear
        image.isUserInteractionEnabled = false
        tile.addSubview(image)
        image.pin(to: tile, insets: UIEdgeInsets(top: 22, left: 22, bottom: 22, right: 22))
        NSLayoutConstraint.activate([tile.widthAnchor.constraint(equalToConstant: 170), tile.heightAnchor.constraint(equalToConstant: 118)])
        tile.addAction(UIAction { [weak self, weak tile] _ in self?.showAssets(all.map(\.assetId), index: index, title: "Logo", source: { _ in tile }) }, for: .touchUpInside)
        let backgrounds = [BrandKitLogoBackground.any, .light, .dark].map { background in
            UIAction(title: background.label, state: background == logo.background ? .on : .off) { [weak self] _ in
                self?.model.changeKit { kit in
                    if let at = kit.logos.firstIndex(where: { $0.assetId == logo.assetId }) { kit.logos[at].background = background }
                }
            }
        }
        tile.menu = UIMenu(title: logo.label ?? "", children: [
            UIMenu(title: "Zemin", image: UIImage(systemName: "circle.lefthalf.filled"), children: backgrounds),
            UIAction(title: "Kaldır", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                self?.model.changeKit { $0.logos.removeAll { $0.assetId == logo.assetId } }
            },
        ])
        tile.accessibilityLabel = "Logo, \(logo.background.label)"
        tile.accessibilityHint = "Açar. Zemin ve kaldırmak için basılı tut."
        let caption = UILabel.studio(logo.background.label, size: 12, color: IOSTheme.textSecondary, style: .caption1)
        return UIStackView.v([tile, caption], spacing: 6, alignment: .leading)
    }

    // Colours

    private func buildColors(_ kit: BrandKit) {
        let add = BrandUI.smallPill("Ekle", image: "plus") { [weak self] in self?.editColor(nil) }
        var views: [UIView] = [BrandUI.header("Renkler", detail: "Ad küçük harf ve tire ile (ana-vurgu); kullanım alanı isteğe bağlı.", action: add)]
        if kit.palette.isEmpty {
            views.append(BrandUI.footnote("Renk yok.", color: IOSTheme.textTertiary))
        } else {
            views.append(swatchStrip(kit.palette.map { ($0.name, BrandKitRules.normalizedHex($0.hex) ?? $0.hex, $0.use) }, side: 52) { [weak self] index in self?.editColor(index) })
        }
        addBlock(views, spacing: 14)
    }

    private func editColor(_ index: Int?) {
        let palette = model.kit?.palette ?? []
        let color = index.flatMap { palette.indices.contains($0) ? palette[$0] : nil }
        let editor = BrandColorEditorViewController(color: color, defaultName: BrandKitRules.nextColorName(palette)) { [weak self] result in
            guard let self else { return }
            self.model.changeKit { kit in
                switch (result, index) {
                case (.some(let saved), .some(let at)) where kit.palette.indices.contains(at): kit.palette[at] = saved
                case (.some(let saved), _): kit.palette.append(saved)
                case (.none, .some(let at)) where kit.palette.indices.contains(at): kit.palette.remove(at: at)
                default: break
                }
            }
        }
        presentSheet(editor, detents: [.large()])
    }

    // Fonts

    private func buildFonts(_ kit: BrandKit) {
        let add = BrandUI.menuPill("Ekle", menu: UIMenu(children: [
            UIAction(title: "Font dosyası…", subtitle: "WOFF2, WOFF, TTF, OTF", image: UIImage(systemName: "doc")) { [weak self] _ in self?.pickFiles(kind: .font) },
            UIAction(title: "Mac'te yüklü yazı tipi…", subtitle: "Adıyla (Avenir Next)", image: UIImage(systemName: "laptopcomputer")) { [weak self] _ in self?.addSystemFont() },
        ]))
        var views: [UIView] = [BrandUI.header("Yazı tipleri", detail: "Mac'te yüklü yazı tipleri adıyla kullanılır; aynı ailenin dosyası, yüklü olmayan bir Mac için yedektir.", action: add)]
        if kit.fonts.isEmpty {
            views.append(BrandUI.footnote("Yazı tipi yok; sistem fontu kullanılır.", color: IOSTheme.textTertiary))
            addBlock(views)
            return
        }
        addBlock(views, bottom: 4)
        addRows(kit.fonts.enumerated().map { index, font in fontRow(font, index: index, all: kit.fonts) })
        body.addArrangedSubview(UIView.fixedSpacer(12))
    }

    private func fontRow(_ font: BrandKitFont, index: Int, all: [BrandKitFont]) -> UIView {
        let face = model.face(font, size: 24)
        var detail = [BrandOverview.roleLabel(font.role)]
        if font.isSystem {
            detail.append("Mac'te yüklü")
            detail.append(BrandKitRules.stylesLabel(font))
        } else {
            detail.append(model.fileName(font) ?? "Font dosyası")
            if BrandKitRules.isFallbackFile(font, in: all) { detail.append("Yedek dosya") }
        }
        if face == nil { detail.append("iPhone'da önizlenemiyor") }
        if !font.licenseNote.isEmpty { detail.append(font.licenseNote) }
        let row = BrandRowView(title: font.family, detail: detail.joined(separator: " · ")) { [weak self] in self?.editFont(index) }
        row.titleLabel.font = face ?? IOSTheme.font(22, .semibold, style: .title3)
        return row
    }

    private func editFont(_ index: Int) {
        guard let fonts = model.kit?.fonts, fonts.indices.contains(index) else { return }
        let font = fonts[index]
        let editor = BrandFontEditorViewController(font: font, fileName: model.fileName(font), preview: model.face(font, size: 30)) { [weak self] result in
            self?.model.changeKit { kit in
                guard kit.fonts.indices.contains(index) else { return }
                if let result { kit.fonts[index] = result } else { kit.fonts.remove(at: index) }
            }
        }
        presentSheet(editor, detents: [.large()])
    }

    private func addSystemFont() {
        prompt("Mac'te yüklü yazı tipi", message: "Ailenin Mac'teki adı (ör. Avenir Next). Postlar Mac'te bu adla çizilir; stilleri Mac'te seçebilirsin.", text: nil, placeholder: "Avenir Next", action: "Ekle") { [weak self] typed in
            guard let self else { return }
            let family = typed.trimmingCharacters(in: .whitespacesAndNewlines)
            guard BrandKitRules.isValidFamily(family) else {
                return self.presentError("Bu ad marka kitinde kullanılamaz (yalnızca harf, rakam, boşluk, tire).")
            }
            if self.model.kit?.fonts.contains(where: { $0.isSystem && $0.family.lowercased() == family.lowercased() }) == true {
                return self.presentError("\(family) zaten kitte.")
            }
            self.model.changeKit { $0.fonts.append(BrandKitFont(source: .system, assetId: nil, family: family)) }
        }
    }

    // Sample posts

    private func buildSamples(_ kit: BrandKit) {
        let remaining = BrandKit.maxSamples - kit.samples.count
        let add = BrandUI.smallPill("Ekle", image: "plus") { [weak self] in
            guard remaining > 0 else { return self?.presentError("En fazla \(BrandKit.maxSamples) örnek post görseli kullanılabilir.") ?? () }
            self?.pickImages(kind: .image, limit: remaining)
        }
        let views: [UIView] = [BrandUI.header(
            "Örnek postlar · \(kit.samples.count)/\(BrandKit.maxSamples)",
            detail: "AI analizi için en az \(BrandKit.minSamples) paylaşılmış post görseli; altına paylaşılan metni yazabilirsin.", action: add)]
        if kit.samples.isEmpty {
            addBlock(views + [BrandUI.footnote("Örnek post yok.", color: IOSTheme.textTertiary)])
            return
        }
        addBlock(views, bottom: 12)
        let ids = kit.samples.map(\.assetId)
        var tiles: [UIView] = []
        for (index, sample) in kit.samples.enumerated() {
            let tile = TileButton()
            tile.backgroundColor = IOSTheme.fill
            let image = IOSAssetImageView(store: pageApp?.images, assetId: sample.assetId, displayWidth: PostGridCell.displayWidth)
            image.isUserInteractionEnabled = false
            tile.addSubview(image)
            image.pin(to: tile)
            if let caption = sample.caption, !caption.isEmpty {
                let mark = UIImageView(image: UIImage(systemName: "text.bubble.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
                mark.tintColor = .white
                mark.layer.shadowColor = UIColor.black.cgColor
                mark.layer.shadowOpacity = 0.4
                mark.layer.shadowRadius = 3
                mark.layer.shadowOffset = .zero
                mark.translatesAutoresizingMaskIntoConstraints = false
                tile.addSubview(mark)
                NSLayoutConstraint.activate([
                    mark.topAnchor.constraint(equalTo: tile.topAnchor, constant: 7),
                    mark.trailingAnchor.constraint(equalTo: tile.trailingAnchor, constant: -7),
                ])
            }
            tile.addAction(UIAction { [weak self, weak tile] _ in
                self?.showAssets(ids, index: index, title: "Örnek post", captions: kit.samples.map(\.caption), source: { _ in tile })
            }, for: .touchUpInside)
            tile.menu = UIMenu(title: sample.caption ?? "", children: [
                UIAction(title: "Paylaşılan metin…", image: UIImage(systemName: "text.bubble")) { [weak self] _ in self?.editSampleCaption(sample) },
                UIAction(title: "Kaldır", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in
                    self?.model.changeKit { $0.samples.removeAll { $0.assetId == sample.assetId } }
                },
            ])
            tile.accessibilityLabel = "Örnek post \(index + 1)" + (sample.caption.map { ", \($0)" } ?? "")
            tile.accessibilityHint = "Açar. Metni yazmak ya da kaldırmak için basılı tut."
            tiles.append(tile)
        }
        body.addArrangedSubview(TileGridView(columns: 3, ratio: 5.0 / 4.0, tiles: tiles))
        body.addArrangedSubview(UIView.fixedSpacer(20))
    }

    private func editSampleCaption(_ sample: BrandKitSample) {
        let editor = BrandTextEditorViewController(title: "Paylaşılan metin", text: sample.caption ?? "", placeholder: "Bu görselle paylaşılan metin") { [weak self] text in
            self?.model.changeKit { kit in
                if let at = kit.samples.firstIndex(where: { $0.assetId == sample.assetId }) {
                    let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                    kit.samples[at].caption = trimmed.isEmpty ? nil : trimmed
                }
            }
            return nil
        }
        presentSheet(editor, detents: [.medium(), .large()])
    }

    private func editNotes() {
        let editor = BrandTextEditorViewController(title: "Notlar", text: model.kit?.notes ?? "", placeholder: "Hedef kitle, kaçınılacaklar …") { [weak self] text in
            self?.model.changeKit { $0.notes = text }
            return nil
        }
        presentSheet(editor, detents: [.large()])
    }

    // Skills

    private func buildSkills(_ brand: Brand) {
        let skills = model.skills
        var addActions: [UIMenuElement] = [
            UIAction(title: "Yeni skill", image: UIImage(systemName: "square.and.pencil"), attributes: BrandSkillRules.addBlocker(count: skills.count) == nil ? [] : .disabled) { [weak self] _ in self?.openSkill(nil) },
        ]
        let draftRunning = model.runningJob(.brandSkillDraft)
        addActions.append(UIAction(title: "AI ile çıkar…", subtitle: "Örnek postlardan, kitten ve profilden", image: UIImage(systemName: "sparkles"), attributes: draftRunning == nil ? [] : .disabled) { [weak self] _ in self?.draftSkill() })
        var views: [UIView] = [BrandUI.header(
            "Skill'ler",
            detail: "Ajanın bu marka için uyduğu talimatlar: format ölçüleri, yerleşim, ton, yapılacaklar ve yapılmayacaklar. Açık olanlar sohbete ve post üretimine eklenir.",
            action: BrandUI.menuPill("Ekle", menu: UIMenu(children: addActions)))]
        if let job = draftRunning {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            views.append(UIStackView.h([spinner, BrandUI.footnote((job.progressMessage ?? "Skill çıkarılıyor…") + (job.progress.map { " · %\(Int($0 * 100))" } ?? "")), UIView.spacer()], spacing: 8))
        }
        if let error = model.skillsError {
            views.append(BrandUI.footnote(error, color: .systemRed))
        } else if skills.isEmpty {
            views.append(BrandUI.footnote("Henüz skill yok. “Yeni skill” ile yaz ya da “AI ile çıkar” ile örnek postlardan ve marka kitinden bir taslak çıkar.", color: IOSTheme.textTertiary))
        }
        addBlock(views, bottom: skills.isEmpty ? 20 : 4)
        guard !skills.isEmpty else { return }
        addRows(skills.map { skill in
            let toggle = UISwitch()
            toggle.isOn = skill.enabled
            toggle.onTintColor = IOSTheme.accent
            toggle.accessibilityLabel = "\(skill.name) \(skill.enabled ? "açık" : "kapalı")"
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                guard let self, let toggle else { return }
                let on = toggle.isOn
                Task { if let problem = await self.model.setSkill(skill, enabled: on) { self.presentError(problem) } }
            }, for: .valueChanged)
            let row = BrandRowView(title: skill.name, detail: [skill.description.isEmpty ? "Açıklama yok" : skill.description, BrandSkillRules.meta(skill)].joined(separator: "\n"), trailing: toggle) { [weak self] in
                self?.openSkill(skill)
            }
            row.titleLabel.font = .monospacedSystemFont(ofSize: 15, weight: skill.enabled ? .semibold : .regular)
            row.titleLabel.textColor = skill.enabled ? IOSTheme.textPrimary : IOSTheme.textSecondary
            return row
        })
        body.addArrangedSubview(UIView.fixedSpacer(12))
    }

    func openSkill(_ skill: BrandSkill?) {
        presentSheet(BrandSkillViewController(model: model, skillId: skill?.id), detents: [.large()])
    }

    private func draftSkill() {
        prompt("AI ile skill çıkar", message: "Örnek postlar, marka kiti ve profilden bir skill taslağı yazılır. Taslak kapalı gelir; okuyup düzelttikten sonra açarsın.", text: nil, placeholder: "Odak (isteğe bağlı): ör. carousel formatı", action: "Çıkar") { [weak self] focus in
            guard let self else { return }
            Task {
                self.report(await self.model.draftSkill(focus: focus), success: "Skill çıkarılıyor; bitince listede kapalı olarak görünür.")
            }
        }
    }

    // MARK: - Profil

    func buildProfile(_ brand: Brand) {
        let profiles = model.profiles
        if let error = model.error, profiles.isEmpty {
            addBlock([BrandUI.footnote(error, color: .systemRed)])
            return
        }
        guard let selected = selectedProfile else {
            let analyzing = model.runningJob(.brandAnalyze) != nil
            addBlock([
                UILabel.studio("Bu markanın profili yok", size: 17, weight: .semibold, style: .headline),
                BrandUI.footnote("Marka kitine örnek postlar ekleyip “AI ile analiz et” ile bir taslak çıkarabilir ya da boş bir taslakla başlayabilirsin."),
                UIStackView.h([
                    UIButton.studioPill(title: analyzing ? "Analiz sürüyor" : "AI ile analiz et", kind: .primary, image: "sparkles") { [weak self] in self?.analyze() },
                    UIButton.studioPill(title: "Boş taslak", kind: .secondary) { [weak self] in self?.newDraft(from: nil) },
                    UIView.spacer(),
                ], spacing: 8),
            ], spacing: 10, top: 24)
            return
        }
        let isDraft = selected.status == .draft
        let versions = UIMenu(title: "Profil sürümü", children: profiles.map { profile in
            let state = profile.status == .approved ? "Onaylı" : "Taslak"
            return UIAction(title: "v\(profile.version) · \(state)\(profile.isCurrent ? " · güncel" : "")", subtitle: AssistantStatus.relative(profile.updatedAt), state: profile.version == selected.version ? .on : .off) { [weak self] _ in
                self?.profileVersion = profile.version
                self?.renderAgain()
            }
        })
        let picker = BrandUI.menuPill("v\(selected.version) · \(selected.status.label)\(selected.isCurrent ? " · güncel" : "")", image: "chevron.down", menu: versions)
        picker.configuration?.imagePlacement = .trailing
        let explanation = isDraft
            ? "Taslak: düzenleyip onaylayınca postlar bu profille üretilir."
            : (selected.isCurrent ? "Onaylı ve güncel; değiştirmek için yeni taslak aç." : "Eski bir onaylı sürüm.")
        var actions: [UIView] = []
        if isDraft {
            actions.append(UIButton.studioPill(title: "Onayla", kind: .primary, image: "checkmark") { [weak self] in self?.approve(selected) })
        } else {
            if !selected.isCurrent {
                actions.append(UIButton.studioPill(title: "Güncel yap", kind: .secondary) { [weak self] in self?.approve(selected) })
            }
            actions.append(UIButton.studioPill(title: "Yeni taslak", kind: .ink, image: "plus") { [weak self] in self?.newDraft(from: selected) })
        }
        actions.append(UIView.spacer())
        let approvedLine = selected.approvedAt.map { "Onay: \(TurkishFormat.dayAndTime($0))" } ?? "\(AssistantStatus.relative(selected.updatedAt)) güncellendi"
        addBlock([
            UIStackView.h([picker, UIView.spacer()], spacing: 0),
            BrandUI.footnote("\(explanation) \(approvedLine)."),
            UIStackView.h(actions, spacing: 8),
        ], spacing: 10, top: 18)
        addHairline()

        // Design tokens by group.
        let rows = BrandTokens.rows(selected.tokens)
        if rows.isEmpty {
            addBlock([BrandUI.header("Tasarım değerleri"), BrandUI.footnote("Profilde tasarım değeri yok.", color: IOSTheme.textTertiary)])
        } else {
            for group in BrandTokens.Group.allCases {
                let inGroup = rows.filter { $0.group == group }
                guard !inGroup.isEmpty else { continue }
                addBlock([BrandUI.header(group.rawValue)], top: 18, bottom: 2)
                addRows(inGroup.map { tokenRow($0, profile: selected, editable: isDraft) })
                body.addArrangedSubview(UIView.fixedSpacer(8))
            }
        }
        addHairline()
        addLongText("Ton ve ses", selected.voice, mono: false, editable: isDraft) { [weak self] text in
            await self?.model.updateProfile(selected.version, BrandProfileUpdate(voice: text))
        }
        addHairline()
        addLongText("Tasarım kuralları", selected.designRules, mono: true, editable: isDraft) { [weak self] text in
            await self?.model.updateProfile(selected.version, BrandProfileUpdate(designRules: text))
        }
    }

    /// The version on screen: the one picked, else the current (approved) one, else the newest.
    private var selectedProfile: BrandProfile? {
        if let profileVersion, let picked = model.profiles.first(where: { $0.version == profileVersion }) { return picked }
        return BrandOverview.cardProfile(model.profiles)
    }

    private func tokenRow(_ row: BrandTokens.Row, profile: BrandProfile, editable: Bool) -> UIView {
        var leading: UIView?
        if row.kind == .color {
            let dot = UIView()
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.backgroundColor = BrandKitRules.normalizedHex(row.value).flatMap { UIColor(hexString: $0) } ?? .clear
            dot.layer.cornerRadius = 14
            dot.layer.borderWidth = 1 / UITraitCollection.current.displayScale
            dot.layer.borderColor = IOSTheme.border.cgColor
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 28), dot.heightAnchor.constraint(equalToConstant: 28)])
            leading = dot
        }
        let value = row.kind == .number && row.note == "px" ? "\(row.value) px" : row.value
        let view = BrandRowView(title: row.label, detail: row.kind == .number ? nil : row.note, value: value, leading: leading, onTap: editable ? { [weak self] in
            self?.editToken(row, profile: profile)
        } : nil)
        if row.kind != .text { view.valueLabel.font = IOSTheme.monoDigits(15) }
        if row.path.last == "family", let face = BrandProfileFonts.face(row.value, model: model, size: 17) { view.valueLabel.font = face }
        return view
    }

    private func editToken(_ row: BrandTokens.Row, profile: BrandProfile) {
        let keyboard: UIKeyboardType = row.kind == .number ? .decimalPad : .asciiCapable
        prompt(row.label, message: row.kind == .color ? "#RRGGBB biçiminde." : row.note, text: row.value, action: "Kaydet", keyboard: keyboard) { [weak self] typed in
            guard let self else { return }
            switch BrandTokens.set(profile.tokens, row: row, value: typed) {
            case .failure(let problem):
                self.presentError(problem.message)
            case .success(let tokens):
                Task { self.report(await self.model.updateProfile(profile.version, BrandProfileUpdate(tokens: tokens))) }
            }
        }
    }

    /// A long text (voice, design rules) cut to a few lines; "Tamamını göster" reads it all, the
    /// pencil edits a draft's.
    private func addLongText(_ title: String, _ text: String, mono: Bool, editable: Bool, save: @escaping (String) async -> String?) {
        let action: UIView? = editable ? BrandUI.smallPill("Düzenle", image: "pencil") { [weak self] in
            let editor = BrandTextEditorViewController(title: title, text: text, placeholder: title, mono: mono) { text in await save(text) }
            self?.presentSheet(editor, detents: [.large()])
        } : nil
        let label = UILabel.studio(text.isEmpty ? "—" : text, size: 14, color: text.isEmpty ? IOSTheme.textTertiary : IOSTheme.textPrimary, lines: 10, style: .subheadline)
        if mono { label.font = .monospacedSystemFont(ofSize: 13, weight: .regular) }
        label.lineBreakMode = .byTruncatingTail
        var views: [UIView] = [BrandUI.header(title, action: action), label]
        if text.split(separator: "\n").count > 10 || text.count > 600 {
            views.append(UIStackView.h([BrandUI.smallPill("Tamamını göster", kind: .plain) { [weak self] in
                self?.presentSheet(TextReaderViewController(title: title, text: text), detents: [.large()])
            }, UIView.spacer()], spacing: 0))
        }
        addBlock(views, spacing: 8)
    }

    private func approve(_ profile: BrandProfile) {
        let current = profile.status == .approved
        confirm(current ? "v\(profile.version) yeniden güncel olsun mu?" : "Profil v\(profile.version) onaylansın mı?",
                message: "Yeni postlar bu kurallar ve ses tonuyla üretilir.", action: current ? "Güncel yap" : "Onayla", destructive: false) { [weak self] in
            guard let self else { return }
            Task {
                self.report(await self.model.approveProfile(profile.version), success: current ? "v\(profile.version) yeniden güncel" : "v\(profile.version) onaylandı")
                self.profileVersion = nil
                self.renderAgain()
            }
        }
    }

    private func newDraft(from profile: BrandProfile?) {
        Task {
            let input = profile.map { BrandProfileCreate(tokens: $0.tokens, designRules: $0.designRules, voice: $0.voice) } ?? BrandProfileCreate()
            switch await model.createProfile(input) {
            case .success(let made):
                profileVersion = made.version
                renderAgain()
                Haptics.success()
                Toast.show("Yeni taslak açıldı: v\(made.version)", in: view)
            case .failure(let problem):
                presentError(problem.message)
            }
        }
    }

    // MARK: - Hesaplar

    func buildAccounts(_ overview: BrandOverview) {
        addRows(overview.platforms.map { line in
            let tint = line.needsOwner ? IOSTheme.accent : (line.connected ? IOSTheme.textPrimary : IOSTheme.textTertiary)
            var detail: [String] = []
            if let account = line.account {
                detail.append(account.status.label)
                if let health = account.tokenHealth, health != .unknown { detail.append(health.label) }
                if let expires = account.tokenExpiresAt { detail.append("Erişim \(TurkishFormat.shortDay(expires)) tarihine kadar") }
            } else {
                detail.append("Mac'te Ayarlar → Hesaplar'dan bağlanır")
            }
            var menu: UIMenu?
            if let account = line.account {
                menu = UIMenu(title: "\(line.platform.displayName) · \(account.handle)", children: [
                    UIAction(title: "Bağlantıyı denetle", image: UIImage(systemName: "checkmark.shield")) { [weak self] _ in
                        guard let self else { return }
                        Task { self.report(await self.model.check(account), success: "\(line.platform.displayName) denetlendi") }
                    },
                    UIAction(title: "Bağlantıyı kes…", image: UIImage(systemName: "xmark.circle"), attributes: .destructive) { [weak self] _ in
                        self?.confirm("\(line.platform.displayName) bağlantısı kesilsin mi?", message: "Bu hesaba artık yayın yapılmaz. Yeniden bağlamak Mac'te yapılır.", action: "Bağlantıyı kes") {
                            guard let self else { return }
                            Task { self.report(await self.model.disconnect(account), success: "Bağlantı kesildi") }
                        }
                    },
                ])
            }
            let row = BrandRowView(title: line.platform.displayName, detail: detail.joined(separator: " · "), value: line.value,
                                   leading: PlatformMarkView(line.platform, tint: tint), menu: menu)
            row.valueLabel.textColor = line.needsOwner ? IOSTheme.accent : (line.connected ? IOSTheme.textPrimary : IOSTheme.textTertiary)
            return row
        })
        addHairline()
        addBlock([
            BrandUI.footnote("Hesap bağlamak ve yeniden bağlamak Mac'te Ayarlar → Hesaplar'dan yapılır: Meta ve LinkedIn girişi orada açılır. Buradan bağlantıyı denetleyebilir ya da kesebilirsin."),
        ])
    }

    // MARK: - Ürünler

    func buildProducts() {
        let products = model.products.products
        let add = BrandUI.menuPill("Ekle", menu: UIMenu(children: [
            UIAction(title: "Fotoğraf çek", image: UIImage(systemName: "camera"), attributes: ImagePicking.cameraAvailable ? [] : .disabled) { [weak self] _ in self?.addProduct(camera: true) },
            UIAction(title: "Fotoğraflar'dan seç", image: UIImage(systemName: "photo")) { [weak self] _ in self?.addProduct(camera: false) },
            UIAction(title: "Fotoğrafsız ekle", image: UIImage(systemName: "square.and.pencil")) { [weak self] _ in self?.openProductEditor(photo: nil) },
        ]))
        addBlock([BrandUI.header(
            products.isEmpty ? "Ürünler" : "Ürünler · \(products.count)",
            detail: "Postlar ürünleri doğru adıyla ve fotoğrafıyla gösterir.", action: add)], top: 16, bottom: 14)
        if products.isEmpty {
            if let error = model.products.error {
                addBlock([BrandUI.footnote(error, color: .systemRed)], top: 0)
            } else if model.products.hasLoaded {
                addBlock([BrandUI.footnote("Henüz ürün yok. Ürünün fotoğrafını çek; Mac etiketteki yazıyı okuyup adını önerir.", color: IOSTheme.textTertiary)], top: 0)
            }
            return
        }
        let tiles: [UIView] = products.map { product in
            let tile = TileButton()
            let cell = ProductGridCell(frame: .zero)
            cell.isUserInteractionEnabled = false
            cell.translatesAutoresizingMaskIntoConstraints = false
            if let images = pageApp?.images { cell.configure(product, images: images) }
            tile.addSubview(cell)
            cell.pin(to: tile)
            tile.accessibilityLabel = cell.accessibilityLabel
            tile.accessibilityHint = "Ürünü açar."
            tile.addAction(UIAction { [weak self] _ in self?.openProduct(product.id) }, for: .touchUpInside)
            productTiles[product.id] = cell.artworkView
            return tile
        }
        body.addArrangedSubview(TileGridView(columns: 3, ratio: 1, tiles: tiles))
    }

    private func addProduct(camera: Bool) {
        let open: ([UIImage]) -> Void = { [weak self] images in
            guard let image = images.first else { return }
            self?.openProductEditor(photo: image)
        }
        if camera { ImagePicking.camera(from: self, onPick: open) } else { ImagePicking.photos(from: self, limit: 1, onPick: open) }
    }

    private func openProductEditor(photo: UIImage?) {
        guard let app = pageApp else { return }
        let editor = ProductEditorViewController(app: app, product: nil, newPhoto: photo, brandId: brandId)
        editor.onSaved = { [weak self] saved in self?.model.products.saved(saved) }
        presentSheet(editor, detents: [.large()])
    }

    /// The product's page, zooming out of its tile as in Ürünler.
    private func openProduct(_ id: EntityID) {
        guard let app = pageApp else { return }
        let page = ProductDetailViewController(app: app, model: model.products, productId: id)
        let options = UIViewController.Transition.ZoomOptions()
        options.alignmentRectProvider = { context in
            guard let page = context.zoomedViewController as? ProductDetailViewController else { return .zero }
            return page.pictureRect(in: page.view)
        }
        page.preferredTransition = .zoom(options: options) { [weak self] _ in self?.productTiles[id] }
        navigationController?.pushViewController(page, animated: true)
    }

    // MARK: - Şablonlar

    func buildTemplates() {
        let templates = model.templates
        addBlock([BrandUI.header(
            templates.isEmpty ? "Şablonlar" : "Şablonlar · \(templates.count)",
            detail: "Onaylı postlardan kaydedilen yerleşimler: metinler ve görseller değişir, tasarım aynı kalır. Dokun: bu şablonla yeni post; basılı tut: ad, alanlar, sil.")], top: 16, bottom: 14)
        if let error = model.templatesError {
            addBlock([BrandUI.footnote("Şablonlar yüklenemedi: \(error)", color: .systemRed)], top: 0)
            return
        }
        if templates.isEmpty {
            if model.hasLoaded {
                let empty = EmptyStateView()
                empty.configure(icon: "square.stack.3d.up", title: "Henüz şablon yok", message: "Mac'te onaylı ya da yayınlanmış bir postu açıp “…” menüsünden “Şablon olarak kaydet” de. Başlık, metin, çağrı ve görsel yuvaları doldurulabilir alan olur.")
                empty.heightAnchor.constraint(greaterThanOrEqualToConstant: 220).isActive = true
                body.addArrangedSubview(empty)
            }
            return
        }
        let tiles: [UIView] = templates.map { template in
            let tile = TemplateTileView(template: template, images: pageApp?.images)
            tile.addAction(UIAction { [weak self] _ in self?.useTemplate(template) }, for: .touchUpInside)
            var actions: [UIMenuElement] = [
                UIAction(title: "Bu şablonla yeni post", image: UIImage(systemName: "plus.square.on.square")) { [weak self] _ in self?.useTemplate(template) },
                UIAction(title: "Ad ve alanlar…", image: UIImage(systemName: "slider.horizontal.3")) { [weak self] _ in self?.editTemplate(template) },
            ]
            if let source = template.source.contentId {
                actions.append(UIAction(title: "Kaynak postu aç", subtitle: "“\(template.source.title)” v\(template.source.version)", image: UIImage(systemName: "arrow.up.forward.square")) { [weak self] _ in
                    self?.pageApp?.open(.post(source))
                })
            }
            tile.menu = UIMenu(title: "\(template.name)\n\(TemplateRules.line(template)) · \(TemplateRules.uses(template))", children: [
                UIMenu(options: .displayInline, children: actions),
                UIAction(title: "Sil…", image: UIImage(systemName: "trash"), attributes: .destructive) { [weak self] _ in self?.deleteTemplate(template) },
            ])
            return tile
        }
        body.addArrangedSubview(TileGridView(columns: 3, ratio: 4.0 / 3.0, tiles: tiles))
    }

    private func useTemplate(_ template: ContentTemplate) {
        guard let app = pageApp else { return }
        let sheet = TemplateUseViewController(app: app, model: model, template: template)
        presentSheet(sheet, detents: [.large()])
    }

    private func editTemplate(_ template: ContentTemplate) {
        presentSheet(TemplateSettingsViewController(model: model, template: template), detents: [.large()])
    }

    private func deleteTemplate(_ template: ContentTemplate) {
        confirm("“\(template.name)” şablonu silinsin mi?", message: "Bu şablonla yapılan postlar ve plan kalemleri tasarımlarını korur; yalnızca şablon bağlantısı kalkar.", action: "Sil") { [weak self] in
            guard let self else { return }
            Task { self.report(await self.model.deleteTemplate(template), success: "“\(template.name)” silindi") }
        }
    }

    // MARK: - Pictures and files

    /// Pictures from Photos into the kit (a picture with transparency stays PNG).
    private func pickImages(kind: AssetKind, limit: Int) {
        ImagePicking.photos(from: self, limit: limit) { [weak self] images in
            guard let self else { return }
            var files: [UploadFile] = []
            for (index, image) in images.enumerated() {
                let name = kind == .logo ? "logo-\(index + 1)" : "ornek-post-\(index + 1)"
                if let imported = try? IOSImageImport.from(image: image, filename: "\(name).jpg") { files.append(imported.file) }
            }
            Task { await self.model.upload(files, kind: kind) }
        }
    }

    /// Logo or font files from the Files app.
    private func pickFiles(kind: AssetKind) {
        BrandFilePicker.pick(from: self, fonts: kind == .font) { [weak self] files in
            guard let self, !files.isEmpty else { return }
            Task { await self.model.upload(files, kind: kind) }
        }
    }

    private func showAssets(_ ids: [EntityID], index: Int, title: String, captions: [String?] = [], source: @escaping (Int) -> UIView?) {
        guard let images = pageApp?.images else { return }
        let items = ids.enumerated().map { offset, id in
            PhotoViewerItem(assetId: id, title: title, subtitle: captions.indices.contains(offset) ? captions[offset] : (ids.count > 1 ? "\(offset + 1) / \(ids.count)" : nil), aspect: nil)
        }
        PhotoViewerViewController(images: images, items: items, index: index, sourceFor: source).open(from: self)
    }
}

/// A kit font family's face for the Profil tab's token rows.
@MainActor
enum BrandProfileFonts {
    static func face(_ family: String, model: BrandPageModel, size: CGFloat) -> UIFont? {
        if let font = model.kit?.fonts.first(where: { $0.family.lowercased() == family.lowercased() }), let face = model.face(font, size: size) { return face }
        return BrandPageModel.installedFace(family, size: size)
    }
}

// MARK: - Tiles

/// A grid tile: a tap does its main thing, a long press shows its menu.
class TileButton: UIButton {
    override init(frame: CGRect) {
        super.init(frame: frame)
        clipsToBounds = true
        isAccessibilityElement = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override var isHighlighted: Bool {
        didSet { alpha = isHighlighted ? 0.75 : 1 }
    }
}

/// A template in the grid: its first slide's render (a stack icon while there is none), the
/// number of slides at the top right and its name at the bottom.
final class TemplateTileView: TileButton {
    init(template: ContentTemplate, images: IOSImageStore?) {
        super.init(frame: .zero)
        backgroundColor = IOSTheme.postMuted
        if let preview = template.previewAssetId {
            let image = IOSAssetImageView(store: images, assetId: preview, displayWidth: PostGridCell.displayWidth)
            image.isUserInteractionEnabled = false
            addSubview(image)
            image.pin(to: self)
        } else {
            let icon = UIImageView(image: UIImage(systemName: "square.stack.3d.up", withConfiguration: UIImage.SymbolConfiguration(pointSize: 26, weight: .light)))
            icon.tintColor = IOSTheme.textTertiary
            icon.translatesAutoresizingMaskIntoConstraints = false
            addSubview(icon)
            NSLayoutConstraint.activate([icon.centerXAnchor.constraint(equalTo: centerXAnchor), icon.centerYAnchor.constraint(equalTo: centerYAnchor, constant: -10)])
        }
        let shade = GradientView(frame: .zero)
        shade.translatesAutoresizingMaskIntoConstraints = false
        shade.isUserInteractionEnabled = false
        addSubview(shade)
        let name = UILabel.studio(TurkishFormat.upper(template.name), size: 11, weight: .heavy, color: .white, lines: 2, style: .caption2)
        addSubview(name)
        NSLayoutConstraint.activate([
            shade.leadingAnchor.constraint(equalTo: leadingAnchor),
            shade.trailingAnchor.constraint(equalTo: trailingAnchor),
            shade.bottomAnchor.constraint(equalTo: bottomAnchor),
            shade.heightAnchor.constraint(equalTo: heightAnchor, multiplier: 0.45),
            name.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
            name.trailingAnchor.constraint(lessThanOrEqualTo: trailingAnchor, constant: -8),
            name.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -8),
        ])
        if template.slideCount > 1 || template.kind == .canvas {
            let mark = UIImageView(image: UIImage(systemName: template.slideCount > 1 ? "square.fill.on.square.fill" : "paintbrush.pointed.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 13, weight: .semibold)))
            mark.tintColor = .white
            mark.layer.shadowColor = UIColor.black.cgColor
            mark.layer.shadowOpacity = 0.35
            mark.layer.shadowRadius = 3
            mark.layer.shadowOffset = .zero
            mark.translatesAutoresizingMaskIntoConstraints = false
            addSubview(mark)
            NSLayoutConstraint.activate([mark.topAnchor.constraint(equalTo: topAnchor, constant: 7), mark.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -7)])
        }
        accessibilityLabel = "\(template.name), \(TemplateRules.line(template)), \(TemplateRules.uses(template))"
        accessibilityHint = "Bu şablonla yeni post. Ayarlar ve silmek için basılı tut."
    }

    required init?(coder: NSCoder) { fatalError("not used") }
}

extension UIView {
    /// Fixed vertical room in a stack.
    static func fixedSpacer(_ height: CGFloat) -> UIView {
        let view = UIView()
        view.translatesAutoresizingMaskIntoConstraints = false
        view.heightAnchor.constraint(equalToConstant: height).isActive = true
        return view
    }
}
