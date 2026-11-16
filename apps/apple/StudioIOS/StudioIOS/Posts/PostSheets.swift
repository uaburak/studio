import StudioKit
import UIKit

/// Caption and hashtags with live platform counters.
final class CaptionEditorViewController: UIViewController, UITextViewDelegate {
    private let session: PostEditSession
    private let bodyView = UITextView()
    private let hashtagsView = UITextView()
    private let counters = UIStackView.v([], spacing: 4)
    private var saveItem: UIBarButtonItem!

    init(session: PostEditSession) {
        self.session = session
        super.init(nibName: nil, bundle: nil)
        title = "Açıklama"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        session.resetCaptionDraft()
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in
            self?.session.resetCaptionDraft()
            self?.dismiss(animated: true)
        })
        saveItem = UIBarButtonItem(title: "Kaydet", primaryAction: UIAction { [weak self] _ in self?.save() })
        saveItem.style = .prominent
        saveItem.tintColor = IOSTheme.accent
        navigationItem.rightBarButtonItem = saveItem

        for view in [bodyView, hashtagsView] {
            view.font = IOSTheme.font(16)
            view.adjustsFontForContentSizeCategory = true
            view.textColor = IOSTheme.textPrimary
            view.backgroundColor = IOSTheme.elevated
            view.layer.cornerRadius = 16
            view.layer.cornerCurve = .continuous
            view.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
            view.delegate = self
            view.translatesAutoresizingMaskIntoConstraints = false
        }
        bodyView.text = session.captionDraft
        bodyView.accessibilityLabel = "Açıklama metni"
        hashtagsView.text = session.hashtagsDraft
        hashtagsView.textColor = IOSTheme.textSecondary
        hashtagsView.autocapitalizationType = .none
        hashtagsView.accessibilityLabel = "Etiketler"

        let note = UILabel.studio("Açıklama değişince onay düşer; post yeniden onaylanmalı.", size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1)
        let stack = UIStackView.v([
            UILabel.studio("Metin", size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), bodyView,
            UILabel.studio("Etiketler", size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), hashtagsView,
            counters, note,
        ], spacing: 8)
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
            bodyView.heightAnchor.constraint(greaterThanOrEqualToConstant: 160),
            hashtagsView.heightAnchor.constraint(equalToConstant: 76),
        ])
        bodyView.setContentHuggingPriority(.defaultLow, for: .vertical)
        updateCounters()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        bodyView.becomeFirstResponder()
    }

    func textViewDidChange(_ textView: UITextView) {
        session.captionDraft = bodyView.text
        session.hashtagsDraft = hashtagsView.text
        updateCounters()
    }

    private func updateCounters() {
        counters.removeAllArranged()
        for usage in session.captionUsage {
            let over = usage.isOverLimit
            var text = "\(usage.platform.displayName): \(usage.label) karakter"
            if let limit = usage.hashtagLimit { text += " · \(usage.hashtags)/\(limit) etiket" } else { text += " · \(usage.hashtags) etiket" }
            let label = UILabel.studio(text, size: 12, color: over ? IOSTheme.accent : IOSTheme.textSecondary, style: .caption1)
            label.font = IOSTheme.monoDigits(12, over ? .semibold : .regular)
            counters.addArrangedSubview(label)
        }
        saveItem.isEnabled = session.hasCaptionChanges
    }

    private func save() {
        saveItem.isEnabled = false
        Task {
            if await session.saveCaption() {
                Haptics.success()
                dismiss(animated: true)
            } else {
                saveItem.isEnabled = true
                presentError(session.error ?? "Kaydedilemedi.")
                session.error = nil
            }
        }
    }
}

/// Edit one text layer.
final class LayerTextEditorViewController: UIViewController {
    private let original: String
    private let onSave: (String) -> Void
    private let textView = UITextView()

    init(text: String, onSave: @escaping (String) -> Void) {
        self.original = text
        self.onSave = onSave
        super.init(nibName: nil, bundle: nil)
        title = "Metni düzenle"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })
        let save = UIBarButtonItem(title: "Uygula", primaryAction: UIAction { [weak self] _ in
            guard let self else { return }
            let text = self.textView.text ?? ""
            if text != self.original { self.onSave(text) }
            self.dismiss(animated: true)
        })
        save.style = .prominent
        save.tintColor = IOSTheme.accent
        navigationItem.rightBarButtonItem = save

        textView.text = original
        textView.font = IOSTheme.font(18, .medium)
        textView.adjustsFontForContentSizeCategory = true
        textView.backgroundColor = IOSTheme.elevated
        textView.layer.cornerRadius = 16
        textView.textContainerInset = UIEdgeInsets(top: 12, left: 10, bottom: 12, right: 10)
        let hint = UILabel.studio("Yeni satır için return. Mac tasarım kurallarıyla yeniden render eder; yeni sürüm olur.", size: 12, color: IOSTheme.textTertiary, lines: 0, style: .caption1)
        let stack = UIStackView.v([textView, hint], spacing: 8)
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 12),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: view.keyboardLayoutGuide.topAnchor, constant: -12),
            textView.heightAnchor.constraint(greaterThanOrEqualToConstant: 120),
        ])
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        textView.becomeFirstResponder()
    }
}

/// Date, accounts and Zamanla; approves first when the post is not approved yet.
final class ScheduleSheetViewController: UIViewController {
    private unowned let app: IOSAppModel
    private let session: PostEditSession
    private let picker = UIDatePicker()
    private let accountsStack = UIStackView.v([], spacing: 0)
    private var selected: Set<EntityID> = []
    private var scheduleButton: UIButton!
    private var publishNowButton: UIButton!
    private let warning = UILabel.studio("", size: 13, color: IOSTheme.textSecondary, lines: 0, style: .footnote)
    private let preflightStack = UIStackView.v([], spacing: 4)
    private var preflightTask: Task<Void, Never>?

    init(app: IOSAppModel, session: PostEditSession) {
        self.app = app
        self.session = session
        super.init(nibName: nil, bundle: nil)
        title = session.card.schedule == nil ? "Zamanla" : "Zamanı değiştir"
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.groupedBackground
        navigationItem.leftBarButtonItem = UIBarButtonItem(title: "Vazgeç", primaryAction: UIAction { [weak self] _ in self?.dismiss(animated: true) })

        picker.datePickerMode = .dateAndTime
        picker.preferredDatePickerStyle = .inline
        picker.locale = TurkishFormat.locale
        picker.minimumDate = Date().addingTimeInterval(5 * 60)
        picker.minuteInterval = 5
        picker.date = session.defaultScheduleDate
        picker.tintColor = IOSTheme.accent
        picker.translatesAutoresizingMaskIntoConstraints = false

        let accounts = session.schedulableAccounts(app.accounts)
        let existing = Set(session.card.schedule.map { [$0.socialAccountId] } ?? [])
        selected = existing.isEmpty ? Set(accounts.filter { $0.status == .connected }.map(\.id)) : existing
        let accountsCard = IOSCardView(padding: 8, spacing: 0)
        if accounts.isEmpty {
            accountsCard.stack.addArrangedSubview(UILabel.studio("Bu markanın hedef platformlarda bağlı hesabı yok. Hesaplar Mac'te bağlanır (Ayarlar → Hesaplar).", size: 14, color: IOSTheme.textSecondary, lines: 0, style: .subheadline))
        }
        for account in accounts {
            let toggle = UISwitch()
            toggle.isOn = selected.contains(account.id)
            toggle.onTintColor = IOSTheme.ink
            toggle.addAction(UIAction { [weak self, weak toggle] _ in
                guard let self, let toggle else { return }
                if toggle.isOn { self.selected.insert(account.id) } else { self.selected.remove(account.id) }
                self.updateButton()
            }, for: .valueChanged)
            let name = UILabel.studio("\(account.platform.displayName) · \(account.handle)", size: 15, style: .subheadline)
            let status = UILabel.studio(account.status == .connected ? "Bağlı" : account.status.rawValue, size: 12, color: IOSTheme.textTertiary, style: .caption1)
            let row = UIStackView.h([UIStackView.v([name, status], spacing: 1), UIView.spacer(), toggle], spacing: 8)
            row.isLayoutMarginsRelativeArrangement = true
            row.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 8, leading: 8, bottom: 8, trailing: 8)
            accountsCard.stack.addArrangedSubview(row)
        }

        if session.card.schedule != nil {
            warning.text = "Yeni zaman için mevcut zamanlama iptal edilip yeniden kurulur."
        } else if !session.content.status.isSchedulable {
            warning.text = "Post henüz onaylı değil: Zamanla, gördüğün sürümü önce onaylar."
        }
        warning.isHidden = warning.text == nil

        scheduleButton = UIButton.studioPill(title: "Zamanla", kind: .primary) { [weak self] in self?.schedule() }
        publishNowButton = UIButton.studioPill(title: "Şimdi yayınla", kind: .secondary, image: "paperplane") { [weak self] in self?.publishNow() }
        let buttons = UIStackView.h([publishNowButton, UIView.spacer(), scheduleButton], spacing: 8)
        let scroll = UIScrollView()
        scroll.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(scroll)
        scroll.pin(to: view)
        let stack = UIStackView.v([picker, UILabel.studio("Hesaplar", size: 13, weight: .semibold, color: IOSTheme.textSecondary, style: .footnote), accountsCard, preflightStack, warning, buttons], spacing: 12)
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: IOSTheme.gutter),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -IOSTheme.gutter),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor, constant: 8),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor, constant: -24),
            stack.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor, constant: -2 * IOSTheme.gutter),
        ])
        updateButton()
    }

    private func updateButton() {
        scheduleButton.isEnabled = !selected.isEmpty
        publishNowButton.isEnabled = !selected.isEmpty && (session.content.status.isSchedulable || session.card.approvableHash != nil)
        runPreflight()
    }

    /// Platform rules for the chosen accounts (caption length, ratio, token health…), from the API.
    private func runPreflight() {
        preflightTask?.cancel()
        let accounts = Array(selected)
        let contentId = session.content.id
        let service = app.dataService
        preflightTask = Task { [weak self] in
            guard !accounts.isEmpty, let result = try? await service.preflight(contentId: contentId, accountIds: accounts) else {
                self?.preflightStack.removeAllArranged()
                return
            }
            guard let self, !Task.isCancelled else { return }
            self.preflightStack.removeAllArranged()
            var lines: [(String, Bool)] = result.errors.map { ($0.message, true) }
            for target in result.targets {
                lines += target.errors.map { ("\(target.platform.displayName): \($0.message)", true) }
                lines += target.warnings.map { ("\(target.platform.displayName): \($0.message)", false) }
            }
            for (text, isError) in lines.prefix(6) {
                let icon = ChatViews.icon(isError ? "exclamationmark.triangle.fill" : "info.circle", isError ? IOSTheme.accent : IOSTheme.textSecondary)
                self.preflightStack.addArrangedSubview(UIStackView.h([icon, UILabel.studio(text, size: 13, color: isError ? IOSTheme.textPrimary : IOSTheme.textSecondary, lines: 0, style: .footnote)], spacing: 6, alignment: .top))
            }
        }
    }

    private func publishNow() {
        let accounts = Array(selected)
        let names = session.schedulableAccounts(app.accounts).filter { accounts.contains($0.id) }.map { "\($0.platform.displayName) \($0.handle)" }.joined(separator: ", ")
        confirm("Şimdi yayınlansın mı?", message: "\(session.content.title) hemen \(names) hesabında paylaşılır. Bu geri alınamaz.", action: "Yayınla", destructive: false) { [weak self] in
            guard let self else { return }
            Task {
                do {
                    if !self.session.content.status.isSchedulable {
                        guard await self.session.approve() else { return }
                    }
                    _ = try await self.app.dataService.publishNow(contentId: self.session.content.id, accountIds: accounts)
                    Haptics.success()
                    await self.session.reloadContent()
                    await self.app.posts.load()
                    await self.app.calendar.load()
                    self.dismiss(animated: true)
                } catch {
                    self.presentError(IOSAppModel.describe(error))
                }
            }
        }
    }

    private func schedule() {
        let date = picker.date
        let accounts = Array(selected)
        scheduleButton.setPill(title: "Zamanla", kind: .primary, busy: true)
        Task {
            var ok: Bool
            if let existing = session.card.schedule, existing.status == .pending {
                ok = await reschedule(existing, to: date)
                let others = accounts.filter { $0 != existing.socialAccountId }
                if ok, !others.isEmpty { ok = !(await session.schedule(at: date, accountIds: others)).isEmpty }
            } else {
                ok = !(await session.schedule(at: date, accountIds: accounts)).isEmpty
            }
            scheduleButton.setPill(title: "Zamanla", kind: .primary)
            if ok {
                Haptics.success()
                dismiss(animated: true)
            } else if let error = session.error {
                presentError(error)
                session.error = nil
            }
        }
    }

    private func reschedule(_ schedule: Schedule, to date: Date) async -> Bool {
        do {
            _ = try await app.dataService.moveSchedule(schedule, to: date)
            await session.reloadContent()
            await app.posts.load()
            await app.calendar.load()
            return true
        } catch {
            session.error = IOSAppModel.describe(error)
            return false
        }
    }
}
