import StudioKit
import UIKit

/// An opened post: zoomable slides, Post | Sürümler, "Neyi değiştireyim?", Zamanla and Onayla.
/// The design itself is edited on the Mac (no layer editing on the phone); a change asked for
/// here becomes a new version there (PostEditSession).
final class IOSPostDetailViewController: UIViewController {
    enum DetailTab: Int, CaseIterable {
        case post, versions
        var label: String {
            switch self {
            case .post: "Post"
            case .versions: "Sürümler"
            }
        }
    }

    private unowned let app: IOSAppModel
    let session: PostEditSession
    private var detailTab: DetailTab = .post

    private let scroll = UIScrollView()
    private let stack = UIStackView.v([], spacing: 14)
    private let pager = SlidePagerView()
    private let segmented = UISegmentedControl(items: DetailTab.allCases.map(\.label))
    private let tabContent = UIStackView.v([], spacing: 12)
    private let bottomBar = UIView()
    private let instructionField = UITextField()
    private var instructionSend: UIButton!
    private var scheduleButton: UIButton!
    private var approveButton: UIButton!
    private var observation: IOSObservationToken?
    private var tabSignature: Int?
    private var navSignature: Int?
    private var lastError: String?
    private var lastNotice: String?
    /// Passed and skipped checks are folded until asked for.
    private var showAllChecks = false

    init(app: IOSAppModel, card: PostCard) {
        self.app = app
        self.session = app.posts.session(for: card)
        super.init(nibName: nil, bundle: nil)
        hidesBottomBarWhenPushed = true
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.keyboardDismissMode = .interactive
        scroll.alwaysBounceVertical = true
        scroll.topEdgeEffect.style = .soft
        // Hard: the field and the buttons float over the page and must stay readable.
        scroll.bottomEdgeEffect.style = .hard
        setContentScrollView(scroll, for: .top)
        view.addSubview(scroll)
        scroll.addSubview(stack)

        pager.onPageChange = { [weak self] index in self?.session.selectSlide(index) }
        pager.onPlayVideo = { [weak self] id in
            guard let self else { return }
            ReelVideo.play(id, app: self.app, from: self)
        }
        stack.addArrangedSubview(pager)

        segmented.selectedSegmentIndex = 0
        segmented.addAction(UIAction { [weak self] _ in
            guard let self, let tab = DetailTab(rawValue: self.segmented.selectedSegmentIndex) else { return }
            self.setTab(tab)
        }, for: .valueChanged)
        let segmentedRow = UIStackView.h([segmented], spacing: 0)
        segmentedRow.isLayoutMarginsRelativeArrangement = true
        segmentedRow.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: IOSTheme.gutter, bottom: 0, trailing: IOSTheme.gutter)
        stack.addArrangedSubview(segmentedRow)

        tabContent.isLayoutMarginsRelativeArrangement = true
        tabContent.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 0, leading: IOSTheme.gutter, bottom: 24, trailing: IOSTheme.gutter)
        stack.addArrangedSubview(tabContent)

        buildBottomBar()

        NSLayoutConstraint.activate([
            scroll.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            scroll.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            scroll.topAnchor.constraint(equalTo: view.topAnchor),
            scroll.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])

        observation = observeIOS { [weak self] in self?.render() }
        Task { await session.load() }
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        // The page scrolls under the floating bar; its last line stops above it.
        let bottom = max(view.bounds.maxY - bottomBar.frame.minY - view.safeAreaInsets.bottom, 0) + 12
        if scroll.contentInset.bottom != bottom {
            scroll.contentInset.bottom = bottom
            scroll.verticalScrollIndicatorInsets.bottom = bottom
        }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        if let layer = session.selectedLayerId { session.flushNudge(layer) }
    }

    private func setTab(_ tab: DetailTab) {
        self.detailTab = tab
        segmented.selectedSegmentIndex = tab.rawValue
        tabSignature = nil
        Haptics.selection()
        render()
    }

    // MARK: Bottom bar

    private func buildBottomBar() {
        // Floats over the page (the page scrolls under it, with the soft bottom edge).
        bottomBar.translatesAutoresizingMaskIntoConstraints = false
        bottomBar.backgroundColor = .clear

        instructionField.placeholder = "Neyi değiştireyim?"
        instructionField.font = IOSTheme.font(15)
        instructionField.adjustsFontForContentSizeCategory = true
        instructionField.returnKeyType = .send
        instructionField.translatesAutoresizingMaskIntoConstraints = false
        instructionField.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.session.instruction = self.instructionField.text ?? ""
        }, for: .editingChanged)
        instructionField.addAction(UIAction { [weak self] _ in self?.sendInstruction() }, for: .editingDidEndOnExit)
        instructionSend = UIButton.studioIcon("arrow.up.circle.fill", label: "Değişikliği iste", size: 24, tint: IOSTheme.textTertiary) { [weak self] in
            guard let self else { return }
            if self.session.revisionJobId != nil { Task { await self.session.cancelRevision() } } else { self.sendInstruction() }
        }
        // A Liquid Glass capsule, like the app's other fields over content.
        let fieldBox = UIVisualEffectView(effect: UIGlassEffect())
        fieldBox.translatesAutoresizingMaskIntoConstraints = false
        fieldBox.cornerConfiguration = .capsule()
        let fieldRow = UIStackView.h([instructionField, instructionSend], spacing: 4)
        fieldRow.translatesAutoresizingMaskIntoConstraints = false
        fieldBox.contentView.addSubview(fieldRow)
        fieldRow.pin(to: fieldBox.contentView, insets: UIEdgeInsets(top: 2, left: 16, bottom: 2, right: 4))
        fieldBox.heightAnchor.constraint(greaterThanOrEqualToConstant: 42).isActive = true

        scheduleButton = UIButton.studioPill(title: "Zamanla", kind: .secondary) { [weak self] in self?.presentSchedule() }
        approveButton = UIButton.studioPill(title: "Onayla", kind: .primary) { [weak self] in self?.approve() }
        let buttons = UIStackView.h([UIView.spacer(), scheduleButton, approveButton], spacing: 8)
        let barStack = UIStackView.v([fieldBox, buttons], spacing: 10)
        bottomBar.addSubview(barStack)
        view.addSubview(bottomBar)
        // The page's soft bottom edge shapes itself around the floating field and buttons.
        let edge = UIScrollEdgeElementContainerInteraction()
        edge.scrollView = scroll
        edge.edge = .bottom
        bottomBar.addInteraction(edge)
        NSLayoutConstraint.activate([
            barStack.leadingAnchor.constraint(equalTo: bottomBar.leadingAnchor, constant: IOSTheme.gutter),
            barStack.trailingAnchor.constraint(equalTo: bottomBar.trailingAnchor, constant: -IOSTheme.gutter),
            barStack.topAnchor.constraint(equalTo: bottomBar.topAnchor, constant: 10),
            barStack.bottomAnchor.constraint(equalTo: bottomBar.bottomAnchor, constant: -8),
            bottomBar.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            bottomBar.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            bottomBar.bottomAnchor.constraint(equalTo: view.keyboardLayoutGuide.topAnchor),
        ])
    }

    // MARK: Render

    private func render() {
        let s = session
        title = s.content.title
        var navHasher = Hasher()
        navHasher.combine(s.canUndo)
        navHasher.combine(s.canRedo)
        navHasher.combine(s.slides.contains { $0.renderedAssetId != nil })
        navHasher.combine(s.content.status)
        let navSignature = navHasher.finalize()
        if navSignature != self.navSignature {
            self.navSignature = navSignature
            navigationItem.rightBarButtonItems = navItems()
        }

        let placeholder = (title: s.content.title, eyebrow: s.card.eyebrow, needsImage: s.card.needsImage)
        pager.configure(
            slides: s.slides, placeholder: placeholder, images: app.images, editing: false,
            selectedLayer: s.selectedLayerId, previewBoxes: s.previewBoxes, selectedSlide: s.selectedSlideIndex)
        let exporting = s.isExporting ? (s.exportMessage ?? "Hazırlanıyor") : nil
        pager.setActivity(s.activity.isBusy ? s.activity.message : exporting)

        // Bottom bar
        if !instructionField.isFirstResponder, instructionField.text != s.instruction { instructionField.text = s.instruction }
        let revising = s.revisionJobId != nil
        instructionField.isEnabled = !revising
        var sendConfig = instructionSend.configuration
        sendConfig?.image = UIImage(systemName: revising ? "stop.circle.fill" : "arrow.up.circle.fill", withConfiguration: UIImage.SymbolConfiguration(pointSize: 24))
        sendConfig?.baseForegroundColor = revising ? IOSTheme.ink : (s.instruction.trimmingCharacters(in: .whitespaces).isEmpty ? IOSTheme.textTertiary : IOSTheme.accent)
        instructionSend.configuration = sendConfig
        instructionSend.accessibilityLabel = revising ? "AI düzenlemesini durdur" : "Değişikliği iste"

        let approved = s.content.status.hasApproval
        approveButton.setPill(title: approved ? "Onaylandı" : "Onayla", kind: approved ? .secondary : .primary, busy: s.isApproving, image: approved ? "checkmark" : nil)
        approveButton.isEnabled = !approved && s.canApprove
        scheduleButton.setPill(title: s.card.schedule != nil ? "Zamanı değiştir" : "Zamanla", kind: .secondary, busy: s.isScheduling)
        scheduleButton.isEnabled = !s.content.status.isLocked && (s.content.status.isSchedulable || s.card.approvableHash != nil)

        // Tab content (rebuilt only when what it shows changed)
        var hasher = Hasher()
        hasher.combine(detailTab)
        hasher.combine(s.card)
        hasher.combine(s.displayedVersion?.id)
        hasher.combine(s.selectedSlideIndex)
        hasher.combine(s.selectedLayerId)
        hasher.combine(s.versionSummaries)
        hasher.combine(s.activity)
        hasher.combine(s.canUndo)
        hasher.combine(s.canRedo)
        hasher.combine(app.posts.slotUploads[s.content.id])
        hasher.combine(s.checkRun)
        hasher.combine(s.checkRunVersion)
        hasher.combine(s.isLoadingChecks)
        hasher.combine(s.checksError)
        hasher.combine(s.isStartingChecks)
        hasher.combine(s.checksRunning)
        hasher.combine(s.runningCheckJob?.progressMessage)
        hasher.combine(showAllChecks)
        let signature = hasher.finalize()
        if signature != tabSignature {
            tabSignature = signature
            tabContent.removeAllArranged()
            switch detailTab {
            case .post: buildPostTab()
            case .versions: buildVersionsTab()
            }
        }

        if let error = s.error, error != lastError {
            lastError = error
            Toast.show(error, in: view, isError: true)
            Haptics.error()
            s.error = nil
        } else if s.error == nil {
            lastError = nil
        }
        if let notice = s.notice, notice != lastNotice {
            lastNotice = notice
            Toast.show(notice, in: view)
            s.notice = nil
        } else if s.notice == nil {
            lastNotice = nil
        }
    }

    private func navItems() -> [UIBarButtonItem] {
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis.circle"), menu: moreMenu())
        more.accessibilityLabel = "Diğer işlemler"
        var items = [more]
        if session.canRedo || session.canUndo {
            let redo = UIBarButtonItem(image: UIImage(systemName: "arrow.uturn.forward"), primaryAction: UIAction { [weak self] _ in
                guard let self else { return }
                Task { await self.session.redo() }
            })
            redo.isEnabled = session.canRedo
            redo.accessibilityLabel = "Yinele"
            let undo = UIBarButtonItem(image: UIImage(systemName: "arrow.uturn.backward"), primaryAction: UIAction { [weak self] _ in
                guard let self else { return }
                Task { await self.session.undo() }
            })
            undo.isEnabled = session.canUndo
            undo.accessibilityLabel = "Geri al"
            items += [redo, undo]
        }
        return items
    }

    private func moreMenu() -> UIMenu {
        let hasRender = session.slides.contains { $0.renderedAssetId != nil }
        let export = UIMenu(title: "Paylaş ve kaydet", options: .displayInline, children: [
            UIAction(title: "Paylaş", image: UIImage(systemName: "square.and.arrow.up"), attributes: hasRender ? [] : .disabled) { [weak self] _ in self?.share(.jpeg) },
            UIAction(title: "Fotoğraflar'a kaydet", image: UIImage(systemName: "square.and.arrow.down")) { [weak self] _ in self?.saveToPhotos() },
            UIAction(title: "PDF olarak paylaş", image: UIImage(systemName: "doc.richtext")) { [weak self] _ in self?.share(.pdf) },
            UIAction(title: "PNG olarak paylaş", image: UIImage(systemName: "photo")) { [weak self] _ in self?.share(.png) },
            UIAction(title: "Açıklamayı kopyala", image: UIImage(systemName: "doc.on.doc")) { [weak self] _ in
                UIPasteboard.general.string = self?.session.content.caption
                Toast.show("Açıklama kopyalandı", in: self?.view)
            },
        ])
        let blocker = IOSPostsModel.deletionBlocker(session.card)
        let manage = UIMenu(title: "", options: .displayInline, children: [
            UIAction(title: "Çoğalt", image: UIImage(systemName: "plus.square.on.square")) { [weak self] _ in self?.duplicate() },
            UIAction(title: "Sil…", image: UIImage(systemName: "trash"), attributes: blocker == nil ? .destructive : [.destructive, .disabled]) { [weak self] _ in self?.delete() },
        ])
        return UIMenu(children: [export, manage])
    }

    // MARK: Post tab

    private func buildPostTab() {
        let s = session
        let card = s.card

        // Status
        var statusViews: [UIView] = [IOSStatusDotView(color: card.state.tone.uiColor, size: 8), UILabel.studio(card.state.label, size: 15, weight: .semibold, style: .subheadline)]
        if let schedule = card.schedule {
            statusViews.append(UILabel.studio("· \(TurkishFormat.dayAndTime(schedule.scheduledAt))", size: 15, color: IOSTheme.textSecondary, style: .subheadline))
        }
        statusViews.append(UIView.spacer())
        tabContent.addArrangedSubview(UIStackView.h(statusViews, spacing: 8))

        if !s.isViewingCurrentVersion, let shown = s.activeVersion?.version {
            tabContent.addArrangedSubview(oldVersionBanner(shown))
        }
        if let failure = card.generationFailure {
            tabContent.addArrangedSubview(failureCard(failure))
        }

        // Caption
        // As on a Postlar post: the brand in bold, the caption, its hashtags.
        let captionCard = Self.section(spacing: 8)
        let parts = CaptionParts(caption: s.content.caption)
        let body = UILabel.studio("", size: 15, lines: 0, style: .subheadline)
        if parts.body.isEmpty {
            body.text = "Açıklama yok"
            body.textColor = IOSTheme.textTertiary
        } else {
            let text = NSMutableAttributedString(string: PostPresentation.brandName(app) + " ", attributes: [.font: IOSTheme.font(15, .semibold, style: .subheadline), .foregroundColor: IOSTheme.textPrimary])
            text.append(NSAttributedString(string: parts.body, attributes: [.font: IOSTheme.font(15, style: .subheadline), .foregroundColor: IOSTheme.textPrimary]))
            body.attributedText = text
        }
        captionCard.stack.addArrangedSubview(body)
        if !parts.hashtags.isEmpty {
            captionCard.stack.addArrangedSubview(UILabel.studio(parts.hashtags.joined(separator: " "), size: 15, lines: 0, style: .subheadline))
        }
        let usage = CaptionLimits.usage(caption: s.content.caption, platforms: s.content.targetPlatforms)
        let counters = usage.map { "\($0.platform.displayName) \($0.label)" }.joined(separator: " · ")
        let over = usage.contains(where: \.isOverLimit)
        let counterLabel = UILabel.studio(counters, size: 12, color: over ? IOSTheme.accent : IOSTheme.textTertiary, lines: 2, style: .caption1)
        counterLabel.font = IOSTheme.monoDigits(12)
        let edit = UIButton.studioIcon("pencil", label: "Açıklamayı düzenle", size: 15, tint: IOSTheme.textSecondary) { [weak self] in self?.presentCaptionEditor() }
        edit.isEnabled = !s.content.status.isLocked
        captionCard.stack.addArrangedSubview(UIStackView.h([counterLabel, UIView.spacer(), edit], spacing: 8))
        tabContent.addArrangedSubview(captionCard)

        // Details
        tabContent.addArrangedSubview(Self.hairline())
        let info = Self.section(spacing: 10)
        let dateText: String = {
            if let schedule = card.schedule { return TurkishFormat.dayAndTime(schedule.scheduledAt) }
            if let day = card.planItem?.date { return TurkishFormat.longDay(day) + ", 09:00" }
            return "Tarih yok"
        }()
        info.stack.addArrangedSubview(infoRow("Tarih", dateText))
        info.stack.addArrangedSubview(infoRow("Platform", TurkishFormat.platforms(s.content.targetPlatforms)))
        info.stack.addArrangedSubview(infoRow("Tür", TurkishFormat.typeLabel(s.content.type, slides: s.slides)))
        if let version = s.activeVersion {
            info.stack.addArrangedSubview(infoRow("Sürüm", "v\(version.version) · \(Self.originLabel(version.origin))"))
        }
        let accounts = s.schedulableAccounts(app.accounts)
        info.stack.addArrangedSubview(infoRow("Hesaplar", accounts.isEmpty ? "Bağlı hesap yok" : accounts.map { "\($0.platform.displayName) \($0.handle)" }.joined(separator: ", ")))
        if !s.content.brief.isEmpty {
            info.stack.addArrangedSubview(infoRow("Brif", s.content.brief))
        }
        tabContent.addArrangedSubview(info)

        if s.content.type != .reel || s.checkRun != nil {
            tabContent.addArrangedSubview(Self.hairline())
            tabContent.addArrangedSubview(checksCard())
        }

        if let blocker = s.approveBlocker, !s.content.status.hasApproval, s.activity == .idle {
            tabContent.addArrangedSubview(UILabel.studio(blocker, size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote))
        }
        if s.card.needsImage {
            // A canvas version's slots are filled on the Mac's canvas.
            tabContent.addArrangedSubview(s.isCanvasVersion || s.card.isCanvasVersion ? canvasNoteCard() : slotCard())
        }
    }

    /// "Üretilemedi": the reason in plain words and "Yeniden dene" (`POST /api/jobs/{id}/retry`).
    private func failureCard(_ failure: GenerationFailure) -> UIView {
        let card = IOSCardView(padding: 16, spacing: 8)
        let title = UIStackView.h([
            IOSStatusDotView(color: IOSTheme.accent, size: 8),
            UILabel.studio(session.content.currentVersion == nil ? "Post üretilemedi" : "Son düzenleme üretilemedi", size: 15, weight: .semibold, style: .subheadline),
            UIView.spacer(),
        ], spacing: 8)
        card.stack.addArrangedSubview(title)
        card.stack.addArrangedSubview(UILabel.studio(failure.reason, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        let retry = UIButton.studioPill(title: "Yeniden dene", kind: .primary, image: "arrow.clockwise") { [weak self] in
            guard let self else { return }
            Task {
                if await self.app.posts.retryGeneration(self.session.card) {
                    Haptics.success()
                    Toast.show("Yeniden üretiliyor", in: self.view)
                } else if let error = self.app.posts.error {
                    self.presentError(error)
                }
            }
        }
        retry.isEnabled = !session.content.status.isLocked
        card.stack.addArrangedSubview(UIStackView.h([retry, UIView.spacer()], spacing: 0))
        return card
    }

    // MARK: Checks

    private func checksCard() -> UIView {
        let s = session
        let card = Self.section(spacing: 10)
        let shown = s.activeVersion?.version
        let run = s.checkRunVersion == shown ? s.checkRun : nil
        let running = s.checksRunning

        var header: [UIView] = []
        if let run { header.append(Self.checkIcon(ContentChecks.overallStatus(run), size: 15)) }
        let title = UILabel.studio("Kontroller", size: 15, weight: .semibold, style: .subheadline)
        title.accessibilityTraits = .header
        header += [title, UIView.spacer()]
        if running || s.isStartingChecks {
            let spinner = UIActivityIndicatorView(style: .medium)
            spinner.startAnimating()
            let message = s.runningCheckJob?.progressMessage.flatMap { $0.isEmpty ? nil : $0 } ?? "Kontroller çalışıyor"
            header += [spinner, UILabel.studio(message, size: 12, color: IOSTheme.textSecondary, lines: 1, style: .caption1)]
        } else if shown != nil {
            let rerun = UIButton.studioPill(title: run == nil ? "Kontrolleri çalıştır" : "Yeniden kontrol et", kind: .secondary, image: "arrow.clockwise") { [weak self] in
                guard let self else { return }
                Task { await self.session.runChecks() }
            }
            header.append(rerun)
        }
        card.stack.addArrangedSubview(UIStackView.h(header, spacing: 8))

        guard let version = shown else {
            card.stack.addArrangedSubview(Self.footnote("Henüz tasarım yok."))
            return card
        }
        if run == nil {
            if s.isLoadingChecks && s.checkRunVersion != version {
                card.stack.addArrangedSubview(Self.footnote("Kontroller yükleniyor…"))
            } else if let error = s.checksError {
                card.stack.addArrangedSubview(UILabel.studio("Kontroller okunamadı: \(error)", size: 13, color: IOSTheme.accent, lines: 0, style: .footnote))
            } else if running {
                card.stack.addArrangedSubview(Self.footnote("Kontroller çalışıyor; sonuç birazdan burada."))
            } else {
                card.stack.addArrangedSubview(Self.footnote("v\(version) henüz kontrol edilmedi."))
            }
            return card
        }
        guard let run else { return card }

        var detail = "\(ContentChecks.summaryText(run)) · v\(run.version) · \(AssistantStatus.relative(run.createdAt))"
        if let fixed = run.fixedVersion { detail += " · v\(fixed) olarak düzeltildi" }
        if let from = run.fromVersion { detail += " · v\(from) sürümünün otomatik düzeltmesi" }
        card.stack.addArrangedSubview(Self.footnote(detail))

        let groups = ContentChecks.groups(run)
        for group in groups where group.isProblem {
            card.stack.addArrangedSubview(groupHeader(group))
            for result in group.results { card.stack.addArrangedSubview(checkRow(result)) }
        }
        let folded = groups.filter { !$0.isProblem }
        if !folded.isEmpty {
            if showAllChecks {
                for group in folded {
                    card.stack.addArrangedSubview(groupHeader(group))
                    for result in group.results { card.stack.addArrangedSubview(checkRow(result)) }
                }
            }
            let counts = folded.map { "\($0.results.count) \($0.status == .pass ? "geçti" : "atlandı")" }.joined(separator: " · ")
            let toggle = UIButton.studioPill(title: showAllChecks ? "Gizle" : "\(counts) · Göster", kind: .plain, image: showAllChecks ? "chevron.up" : "chevron.down") { [weak self] in
                guard let self else { return }
                self.showAllChecks.toggle()
                self.tabSignature = nil
                self.render()
            }
            toggle.contentHorizontalAlignment = .leading
            card.stack.addArrangedSubview(UIStackView.h([toggle, UIView.spacer()], spacing: 0))
        }
        if run.results.contains(where: { $0.fixable && ($0.status == .fail || $0.status == .warn) }) {
            card.stack.addArrangedSubview(Self.footnote("Otomatik düzeltme Mac'te, postun Kontroller bölümünde."))
        }
        return card
    }

    private func groupHeader(_ group: ContentChecks.Group) -> UIView {
        let label = UILabel.studio("\(group.title) (\(group.results.count))", size: 13, weight: .semibold, color: Self.checkColor(group.status), style: .footnote)
        label.accessibilityTraits = .header
        return label
    }

    private func checkRow(_ result: ContentCheckResult) -> UIView {
        let icon = Self.checkIcon(result.status, size: 13)
        var titleViews: [UIView] = [UILabel.studio(ContentChecks.label(result.checkId), size: 15, weight: .medium, lines: 0, style: .subheadline)]
        if result.isModel { titleViews.append(Self.badge("AI", ink: false)) }
        titleViews.append(UIView.spacer())
        var texts: [UIView] = [UIStackView.h(titleViews, spacing: 6)]
        if !result.message.isEmpty {
            texts.append(UILabel.studio(result.message, size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote))
        }
        let place = ContentChecks.placeLabel(result)
        if let place {
            texts.append(UILabel.studio(place, size: 12, color: IOSTheme.textTertiary, lines: 1, style: .caption1))
        }
        let row = UIStackView.h([icon, UIStackView.v(texts, spacing: 2)], spacing: 10, alignment: .top)
        let spoken = "\(result.status.label): \(ContentChecks.label(result.checkId)). \(result.message)\(place.map { ". \($0)" } ?? "")"
        guard let slide = result.refs.first(where: { $0.slide != nil })?.slide else {
            row.isAccessibilityElement = true
            row.accessibilityLabel = spoken
            return row
        }
        // A finding on a slide: tap to show that slide.
        let control = UIControl()
        control.translatesAutoresizingMaskIntoConstraints = false
        control.addSubview(row)
        row.pin(to: control)
        row.isUserInteractionEnabled = false
        control.addAction(UIAction { [weak self] _ in
            guard let self else { return }
            self.session.selectSlide(slide)
            self.scroll.setContentOffset(CGPoint(x: 0, y: -self.scroll.adjustedContentInset.top), animated: true)
            Haptics.selection()
        }, for: .touchUpInside)
        control.isAccessibilityElement = true
        control.accessibilityLabel = spoken
        control.accessibilityHint = "Slaytı gösterir"
        control.accessibilityTraits = .button
        return control
    }

    /// A section of the page: no card, no border (sections are parted by a hairline).
    private static func section(spacing: CGFloat) -> IOSCardView {
        let card = IOSCardView(padding: 0, spacing: spacing, background: .clear)
        card.layer.borderWidth = 0
        card.layer.cornerRadius = 0
        return card
    }

    private static func hairline() -> UIView {
        let line = UIView()
        line.translatesAutoresizingMaskIntoConstraints = false
        line.backgroundColor = IOSTheme.hairline
        line.heightAnchor.constraint(equalToConstant: 1 / UITraitCollection.current.displayScale).isActive = true
        return line
    }

    private static func footnote(_ text: String) -> UILabel {
        UILabel.studio(text, size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    }

    private static func checkColor(_ status: CheckStatus) -> UIColor {
        switch status {
        case .fail: .systemRed
        case .warn: IOSTheme.accent
        case .fixed: IOSTheme.textPrimary
        case .pass, .skipped, .unknown: IOSTheme.textSecondary
        }
    }

    private static func checkIcon(_ status: CheckStatus, size: CGFloat) -> UIView {
        let symbol = switch status {
        case .fail: "xmark.circle.fill"
        case .warn: "exclamationmark.triangle.fill"
        case .fixed: "sparkles"
        case .pass: "checkmark.circle"
        case .skipped, .unknown: "circle.dashed"
        }
        let view = ChatViews.icon(symbol, checkColor(status), size: size)
        view.setContentHuggingPriority(.required, for: .horizontal)
        view.isAccessibilityElement = false
        return view
    }

    /// Asks first when the current version's checks found problems, still run, or never ran;
    /// `proceed` runs right away when they passed.
    private func guardChecks(then proceed: @escaping () -> Void) {
        Task {
            let gate = await session.approvalGate()
            guard let question = gate.question else {
                proceed()
                return
            }
            // "Yine de onayla": the approval that follows tells the API so (E7).
            confirm(question.title, message: question.message, action: "Yine de onayla", destructive: false) { [weak self] in
                self?.session.acknowledgeChecks()
                proceed()
            }
        }
    }

    private func infoRow(_ title: String, _ value: String) -> UIView {
        let titleLabel = UILabel.studio(title, size: 14, color: IOSTheme.textSecondary, style: .subheadline)
        titleLabel.widthAnchor.constraint(equalToConstant: 76).isActive = true
        let valueLabel = UILabel.studio(value, size: 14, weight: .medium, lines: 0, style: .subheadline)
        valueLabel.textAlignment = .right
        let row = UIStackView.h([titleLabel, valueLabel], spacing: 12, alignment: .firstBaseline)
        row.isAccessibilityElement = true
        row.accessibilityLabel = "\(title): \(value)"
        return row
    }

    static func originLabel(_ origin: ContentVersionOrigin) -> String {
        switch origin {
        case .generated: "Üretildi"
        case .manualEdit: "Elle düzenleme"
        case .aiEdit: "AI düzenlemesi"
        case .unknown: "Sürüm"
        }
    }

    private func oldVersionBanner(_ shown: Int) -> UIView {
        let card = IOSCardView(padding: 14, spacing: 10, background: IOSTheme.fill)
        card.layer.borderWidth = 0
        card.stack.addArrangedSubview(UILabel.studio("Eski sürüm (v\(shown)) gösteriliyor. Düzenlemek ya da onaylamak için geri yükle.", size: 14, lines: 0, style: .subheadline))
        let restore = UIButton.studioPill(title: "Bu sürümü geri yükle", kind: .ink) { [weak self] in
            guard let self else { return }
            Task { await self.session.restoreDisplayedVersion() }
        }
        restore.isEnabled = !session.activity.changesVersion
        let back = UIButton.studioPill(title: "Güncel sürüm", kind: .secondary) { [weak self] in
            guard let self else { return }
            Task { await self.session.showCurrentVersion() }
        }
        card.stack.addArrangedSubview(UIStackView.h([restore, back, UIView.spacer()], spacing: 8))
        return card
    }

    // MARK: Missing picture

    /// The design was edited on the Mac's canvas: read only here (texts, pictures, slots).
    private func canvasNoteCard() -> UIView {
        let card = IOSCardView(padding: 14, spacing: 8, background: IOSTheme.fill)
        card.layer.borderWidth = 0
        let icon = ChatViews.icon("laptopcomputer", IOSTheme.textSecondary, size: 13)
        card.stack.addArrangedSubview(UIStackView.h([icon, UILabel.studio(CanvasOrigin.editNote, size: 14, lines: 0, style: .subheadline)], spacing: 8, alignment: .top))
        let ai: String = if let source = session.canvasOrigin?.sourceVersion {
            "“Neyi değiştireyim?” isteği tuvalin başladığı v\(source) üzerinden yeni bir sürüm yapar; Mac onu tuvale yeniden aktarır. Açıklama, onay ve zamanlama burada."
        } else {
            "“Neyi değiştireyim?” isteği yeni bir tasarım sürümü yapar; Mac onu tuvale yeniden aktarır. Açıklama, onay ve zamanlama burada."
        }
        card.stack.addArrangedSubview(Self.footnote(ai))
        return card
    }

    private func slotCard() -> UIView {
        let s = session
        let card = IOSCardView(padding: 14, spacing: 10)
        let empty = s.slots.filter(\.isEmpty).count
        let title = empty > 0 ? "Görsel yuvası boş" : "Görsel yuvası"
        var titleViews: [UIView] = []
        if empty > 0 { titleViews.append(IOSStatusDotView(color: IOSTheme.accent, size: 7)) }
        titleViews += [UILabel.studio(title, size: 15, weight: .semibold, style: .subheadline), UIView.spacer()]
        card.stack.addArrangedSubview(UIStackView.h(titleViews, spacing: 6))
        let hint = s.card.planItem?.imageBrief ?? s.targetSlot?.label ?? "Fotoğraf seç ya da çek; Mac yuvaya yerleştirip yeniden render eder."
        card.stack.addArrangedSubview(UILabel.studio(hint, size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        if case .uploading(let progress) = s.activity {
            let bar = UIProgressView(progressViewStyle: .default)
            bar.progress = Float(progress)
            bar.progressTintColor = IOSTheme.accent
            card.stack.addArrangedSubview(bar)
        }
        var actions: [UIView] = [
            UIButton.studioPill(title: "Fotoğraflardan", kind: empty > 0 ? .primary : .secondary, image: "photo") { [weak self] in self?.pickSlotImage(camera: false) },
        ]
        if ImagePicking.cameraAvailable {
            actions.append(UIButton.studioPill(title: "Kamera", kind: .secondary, image: "camera") { [weak self] in self?.pickSlotImage(camera: true) })
        }
        if let filled = s.slots.first(where: { !$0.isEmpty && $0.slideIndex == s.selectedSlideIndex }), let id = filled.layerId {
            actions.append(UIButton.studioPill(title: "Boşalt", kind: .plain) { [weak self] in self?.session.clearSlot(id) })
        }
        for view in actions { (view as? UIButton)?.isEnabled = s.canEdit && !s.activity.changesVersion }
        card.stack.addArrangedSubview(horizontalScroll(actions))
        return card
    }

    private func horizontalScroll(_ views: [UIView]) -> UIView {
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        let row = UIStackView.h(views, spacing: 8)
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            scroll.heightAnchor.constraint(equalToConstant: 40),
        ])
        return scroll
    }

    // MARK: Versions tab

    private func buildVersionsTab() {
        let s = session
        if !s.isViewingCurrentVersion, let shown = s.activeVersion?.version { tabContent.addArrangedSubview(oldVersionBanner(shown)) }
        let list = IOSCardView(padding: 8, spacing: 0)
        if s.versionSummaries.isEmpty {
            list.stack.addArrangedSubview(UILabel.studio("Henüz sürüm yok.", size: 14, color: IOSTheme.textTertiary))
        }
        let current = s.content.currentVersion?.version
        for summary in s.versionSummaries {
            let isCurrent = summary.version == current
            let isShown = summary.version == s.activeVersion?.version
            let title = UILabel.studio("v\(summary.version) · \(Self.originLabel(summary.origin))", size: 15, weight: isShown ? .semibold : .regular, style: .subheadline)
            var detail = AssistantStatus.relative(summary.createdAt)
            if let note = summary.note, !note.isEmpty { detail += " · \(note)" }
            let detailLabel = UILabel.studio(detail, size: 12, color: IOSTheme.textSecondary, lines: 2, style: .caption1)
            var trailing: [UIView] = []
            if isCurrent { trailing.append(Self.badge("Güncel", ink: true)) }
            if isShown && !isCurrent { trailing.append(Self.badge("Gösteriliyor", ink: false)) }
            let row = UIStackView.h([UIStackView.v([title, detailLabel], spacing: 2), UIView.spacer()] + trailing, spacing: 8)
            row.isLayoutMarginsRelativeArrangement = true
            row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
            let control = UIControl()
            control.translatesAutoresizingMaskIntoConstraints = false
            control.addSubview(row)
            row.pin(to: control)
            control.backgroundColor = isShown ? IOSTheme.fill : .clear
            control.layer.cornerRadius = 12
            control.addAction(UIAction { [weak self] _ in
                guard let self else { return }
                Task {
                    if isCurrent { await self.session.showCurrentVersion() } else { await self.session.selectVersion(summary.version) }
                }
                Haptics.selection()
            }, for: .touchUpInside)
            control.isAccessibilityElement = true
            control.accessibilityLabel = "Sürüm \(summary.version), \(Self.originLabel(summary.origin)), \(detail)\(isCurrent ? ", güncel" : "")"
            control.accessibilityTraits = isShown ? [.button, .selected] : .button
            list.stack.addArrangedSubview(control)
        }
        tabContent.addArrangedSubview(list)
    }

    private static func badge(_ text: String, ink: Bool) -> UIView {
        let label = PaddedLabel(text: text)
        label.backgroundColor = ink ? IOSTheme.ink : IOSTheme.fillStrong
        label.textColor = ink ? IOSTheme.onInk : IOSTheme.textPrimary
        return label
    }

    // MARK: Actions

    private func sendInstruction() {
        let text = session.instruction.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        instructionField.resignFirstResponder()
        Task { await session.sendInstruction() }
    }

    private func approve() {
        guardChecks { [weak self] in
            guard let self else { return }
            Task {
                if await self.session.approve() { Haptics.success() }
            }
        }
    }

    private func presentSchedule() {
        let open = { [weak self] in
            guard let self else { return }
            let sheet = ScheduleSheetViewController(app: self.app, session: self.session)
            self.presentSheet(sheet, detents: [.large()])
        }
        // Scheduling approves first when needed: ask about the checks before that, too.
        if session.content.status.isSchedulable { open() } else { guardChecks(then: open) }
    }

    private func presentCaptionEditor() {
        presentSheet(CaptionEditorViewController(session: session), detents: [.large()])
    }

    private func presentTextEditor(_ layer: SlideLayer) {
        let editor = LayerTextEditorViewController(text: layer.text) { [weak self] text in
            self?.session.setText(layer.layerId, text)
        }
        presentSheet(editor, detents: [.medium(), .large()])
    }

    private func pickSlotImage(camera: Bool) {
        let handle: ([UIImage]) -> Void = { [weak self] images in
            guard let self, let image = images.first else { return }
            do {
                let imported = try IOSImageImport.from(image: image, filename: "yuva.jpg")
                self.session.fillSlot(with: imported.file)
            } catch {
                self.presentError(IOSAppModel.describe(error))
            }
        }
        if camera { ImagePicking.camera(from: self, onPick: handle) } else { ImagePicking.photos(from: self, onPick: handle) }
    }

    private func pickImage(for layerId: String, camera: Bool) {
        let handle: ([UIImage]) -> Void = { [weak self] images in
            guard let self, let image = images.first else { return }
            do {
                let imported = try IOSImageImport.from(image: image, filename: "\(layerId).jpg")
                self.session.placeImage(imported.file, into: layerId)
            } catch {
                self.presentError(IOSAppModel.describe(error))
            }
        }
        if camera { ImagePicking.camera(from: self, onPick: handle) } else { ImagePicking.photos(from: self, onPick: handle) }
    }

    private func share(_ format: PostExportFormat) {
        Task {
            let files = await session.export(format)
            guard !files.isEmpty else { return }
            do {
                let urls = try FileSharing.write(files)
                FileSharing.share(urls, from: self, barItem: navigationItem.rightBarButtonItems?.first)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
        }
    }

    private func saveToPhotos() {
        Task {
            let files = await session.export(.jpeg)
            guard !files.isEmpty else { return }
            do {
                let count = try await FileSharing.saveToPhotos(files)
                Haptics.success()
                Toast.show(count == 1 ? "Fotoğraflar'a kaydedildi" : "\(count) görsel Fotoğraflar'a kaydedildi", in: view)
            } catch {
                presentError(IOSAppModel.describe(error))
            }
        }
    }

    private func duplicate() {
        Task {
            if let copy = await app.posts.duplicate(session.card) {
                navigationController?.pushViewController(IOSPostDetailViewController(app: app, card: copy), animated: true)
            } else if let error = app.posts.error {
                presentError(error)
            }
        }
    }

    private func delete() {
        confirm("“\(session.content.title)” silinsin mi?", message: IOSPostsModel.deleteMessage, action: "Sil") { [weak self] in
            guard let self else { return }
            Task {
                let card = self.session.card
                if await self.app.posts.delete(card) {
                    Haptics.success()
                    let host = self.navigationController?.view
                    self.navigationController?.popViewController(animated: true)
                    IOSPostsModel.showUndo(for: card, model: self.app.posts, in: host)
                } else if let error = self.app.posts.error {
                    self.presentError(error)
                }
            }
        }
    }
}
