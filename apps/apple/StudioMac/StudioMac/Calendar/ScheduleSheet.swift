import AppKit
import Foundation
import Observation
import StudioKit

/// What the schedule sheet opens with. Reusable: the calendar ("+ Zamanla", "Yeniden dene")
/// and the opened post ("Zamanla") both present it.
struct ScheduleSheetRequest: Equatable {
    var brandId: EntityID
    /// nil: the owner picks an approved post in the sheet.
    var contentId: EntityID?
    /// Default local date/time.
    var date: Date?
    /// Preselected accounts (retry keeps the failed one).
    var accountIds: [EntityID] = []
}

/// Model of the schedule sheet: content and accounts, local time, platform rules
/// (preflight, Turkish), schedule or publish now.
@MainActor
@Observable
final class ScheduleSheetModel {
    let request: ScheduleSheetRequest
    private weak var app: AppModel?
    private let api: any PublishingAPI

    private(set) var candidates: [Content] = []
    var contentId: EntityID? { didSet { if contentId != oldValue { selectedAccounts = defaultAccounts(); schedulePreflight() } } }
    var date: Date { didSet { validate() } }
    var selectedAccounts: Set<EntityID> = [] { didSet { if selectedAccounts != oldValue { schedulePreflight() } } }

    private(set) var preflight: SchedulePreflight?
    private(set) var isChecking = false
    private(set) var isSubmitting = false
    private(set) var error: String?
    private(set) var dateError: String?
    private(set) var done: [Schedule] = []
    private var preflightTask: Task<Void, Never>?

    init(app: AppModel, request: ScheduleSheetRequest, api: (any PublishingAPI)? = nil) {
        self.app = app
        self.request = request
        self.api = api ?? app.publishing.api
        self.date = request.date ?? CalendarMath.defaultTime(on: Date().addingTimeInterval(86_400))
        self.contentId = request.contentId
    }

    var content: Content? { candidates.first { $0.id == contentId } }

    /// Accounts of the brand on the content's platforms that can publish.
    var accounts: [SocialAccount] {
        guard let app, let content else { return [] }
        return app.accounts(of: request.brandId).filter {
            content.targetPlatforms.contains($0.platform) && $0.status != .disabled
        }
    }

    var mode: PublishingMode { app?.publishing.mode ?? .local }

    func load() async {
        guard let app else { return }
        do {
            let all = try await app.dataService.contents(brandId: request.brandId)
            candidates = all.filter { $0.currentVersion != nil && ($0.status.isSchedulable || $0.id == request.contentId) }
                .sorted { $0.updatedAt > $1.updatedAt }
            if contentId == nil { contentId = candidates.first?.id }
            if !request.accountIds.isEmpty { selectedAccounts = Set(request.accountIds) } else { selectedAccounts = defaultAccounts() }
            validate()
            schedulePreflight(immediately: true)
        } catch {
            self.error = AppModel.describe(error)
        }
    }

    private func defaultAccounts() -> Set<EntityID> {
        Set(accounts.filter { $0.status == .connected }.map(\.id))
    }

    private func validate() {
        dateError = date < CalendarMath.earliestSchedule() ? "Yayın zamanı en az bir dakika sonrası olmalı." : nil
    }

    /// Debounced: account and post changes re-run the platform rules.
    func schedulePreflight(immediately: Bool = false) {
        preflightTask?.cancel()
        guard let contentId, !selectedAccounts.isEmpty else {
            preflight = nil
            return
        }
        let ids = selectedAccounts.sorted()
        preflightTask = Task { [weak self] in
            if !immediately { try? await Task.sleep(for: .milliseconds(250)) }
            guard let self, !Task.isCancelled else { return }
            self.isChecking = true
            defer { self.isChecking = false }
            do {
                let result = try await self.api.preflight(contentId: contentId, accountIds: ids)
                if !Task.isCancelled { self.preflight = result; self.error = nil }
            } catch {
                if !Task.isCancelled { self.error = AppModel.describe(error) }
            }
        }
    }

    func issues(for accountId: EntityID) -> (errors: [PreflightIssue], warnings: [PreflightIssue]) {
        guard let target = preflight?.target(accountId) else { return ([], []) }
        return (target.errors, target.warnings)
    }

    var needsApproval: Bool { content.map { !$0.status.isSchedulable } ?? false }

    var blockingReason: String? {
        if content == nil { return "Zamanlanacak onaylı bir post seçin." }
        if selectedAccounts.isEmpty { return accounts.isEmpty ? "Bu markada bu postun platformlarında bağlı hesap yok. Ayarlar → Hesaplar'dan bağlayın." : "En az bir hesap seçin." }
        if let preflight {
            if let first = preflight.errors.first { return first.message }
            let bad = selectedAccounts.compactMap { preflight.target($0) }.filter { !$0.ok }
            if let first = bad.first?.errors.first { return "\(bad.first?.handle ?? ""): \(first.message)" }
        }
        return nil
    }

    var canSchedule: Bool { blockingReason == nil && dateError == nil && !isSubmitting && !isChecking }
    var canPublishNow: Bool { blockingReason == nil && !isSubmitting && !isChecking }

    private func approveIfNeeded() async throws {
        guard let content, needsApproval else { return }
        guard let hash = content.currentVersion?.contentHash else { throw StudioAPIError.invalidConfiguration("Onaylanacak sürüm yok.") }
        let approved = try await api.approve(contentId: content.id, hash: hash)
        if let index = candidates.firstIndex(where: { $0.id == approved.id }) { candidates[index] = approved }
    }

    /// One schedule per selected account at `date` (local time → UTC on the wire).
    @discardableResult
    func schedule() async -> Bool {
        guard canSchedule, let contentId else { return false }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await approveIfNeeded()
            var created: [Schedule] = []
            for accountId in selectedAccounts.sorted() {
                created.append(try await api.createSchedule(ScheduleCreate(contentId: contentId, socialAccountId: accountId, scheduledAt: date)))
            }
            done = created
            await afterSubmit(created)
            return true
        } catch {
            self.error = AppModel.describe(error)
            return false
        }
    }

    /// "Şimdi yayınla" (after the owner confirmed).
    @discardableResult
    func publishNow() async -> Bool {
        guard canPublishNow, let contentId else { return false }
        isSubmitting = true
        defer { isSubmitting = false }
        do {
            try await approveIfNeeded()
            let result = try await api.publishNow(contentId: contentId, accountIds: selectedAccounts.sorted())
            done = result.schedules
            await afterSubmit(result.schedules)
            return true
        } catch {
            self.error = AppModel.describe(error)
            return false
        }
    }

    private func afterSubmit(_ schedules: [Schedule]) async {
        guard let app else { return }
        for s in schedules { app.posts.scheduleCreated(s) }
        await app.publishing.notifier.requestPermissionInContext()
        await app.calendar.reloadIfVisible(force: true)
        if app.detail?.content.id == contentId { await app.detail?.reloadVersionsAndContent() }
    }

    var publishNowConfirmation: String {
        let names = accounts.filter { selectedAccounts.contains($0.id) }.map { "\($0.platform.displayName) · \($0.handle)" }
        let title = content?.title ?? "Post"
        return "“\(title)” şu hesaplarda hemen paylaşılacak: \(names.joined(separator: ", ")). Paylaşılan gönderi Studio'dan geri alınamaz."
    }
}

// MARK: - Sheet

final class ScheduleSheetController: NSViewController {
    private unowned let app: AppModel
    let model: ScheduleSheetModel
    private let onDone: () -> Void

    private let contentPopup = NSPopUpButton()
    private let datePicker = NSDatePicker()
    private let timeZoneLabel = NSTextField(labelWithString: "")
    private let accountsStack = NSStackView()
    private let modeLabel = NSTextField(wrappingLabelWithString: "")
    private let blockLabel = NSTextField(wrappingLabelWithString: "")
    private let errorBanner = InlineErrorBannerView()
    private var scheduleButton: PillButton!
    private var publishNowButton: PillButton!
    private var observation: ObservationToken?

    /// Present from any view controller (calendar, opened post).
    @discardableResult
    static func present(from presenter: NSViewController, app: AppModel, request: ScheduleSheetRequest, onDone: @escaping () -> Void = {}) -> ScheduleSheetController {
        let sheet = ScheduleSheetController(app: app, request: request, onDone: onDone)
        presenter.presentAsSheet(sheet)
        return sheet
    }

    init(app: AppModel, request: ScheduleSheetRequest, onDone: @escaping () -> Void) {
        self.app = app
        self.model = ScheduleSheetModel(app: app, request: request)
        self.onDone = onDone
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func loadView() {
        let root = ThemedView()
        root.backgroundColor = Theme.canvas
        root.translatesAutoresizingMaskIntoConstraints = false

        let title = NSTextField.styledLabel(model.request.contentId == nil ? "Zamanla" : "Postu zamanla", font: NSFont.systemFont(ofSize: 15, weight: .semibold))
        let closeButton = PillButton(title: "Vazgeç", kind: .secondary, height: 26) { [weak self] in self?.close() }
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let header = NSStackView(views: [title, spacer, closeButton])
        header.orientation = .horizontal

        contentPopup.target = self
        contentPopup.action = #selector(contentChanged)
        contentPopup.isHidden = model.request.contentId != nil

        datePicker.datePickerStyle = .textFieldAndStepper
        datePicker.datePickerElements = [.yearMonthDay, .hourMinute]
        datePicker.locale = TurkishFormat.locale
        datePicker.timeZone = .current
        datePicker.minDate = Date()
        datePicker.dateValue = model.date
        datePicker.target = self
        datePicker.action = #selector(dateChanged)
        timeZoneLabel.font = Theme.smallFont
        timeZoneLabel.textColor = Theme.textSecondary
        timeZoneLabel.stringValue = "Yerel saat (\(TimeZone.current.localizedName(for: .shortGeneric, locale: TurkishFormat.locale) ?? TimeZone.current.identifier))"
        let dateRow = NSStackView(views: [NSTextField.styledLabel("Yayın zamanı", font: Theme.captionFont, color: Theme.textSecondary), NSView(), datePicker])
        dateRow.orientation = .horizontal

        accountsStack.orientation = .vertical
        accountsStack.alignment = .leading
        accountsStack.spacing = 8

        modeLabel.font = Theme.smallFont
        modeLabel.textColor = Theme.textSecondary
        blockLabel.font = Theme.smallFont
        blockLabel.textColor = Theme.accent
        errorBanner.isHidden = true

        publishNowButton = PillButton(title: "Şimdi yayınla", kind: .secondary, height: 28) { [weak self] in self?.confirmPublishNow() }
        scheduleButton = PillButton(title: "Zamanla", kind: .primary, height: 28) { [weak self] in
            guard let self else { return }
            Task { if await self.model.schedule() { self.close() } }
        }
        let actionsSpacer = NSView()
        actionsSpacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        let actions = NSStackView(views: [actionsSpacer, publishNowButton, scheduleButton])
        actions.orientation = .horizontal
        actions.spacing = 8

        let stack = NSStackView(views: [header, HairlineView(), contentPopup, dateRow, timeZoneLabel, accountsStack, modeLabel, blockLabel, errorBanner, actions])
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.translatesAutoresizingMaskIntoConstraints = false
        root.addSubview(stack)
        for view in [header, contentPopup, dateRow, accountsStack, modeLabel, blockLabel, errorBanner, actions] {
            view.widthAnchor.constraint(equalTo: stack.widthAnchor).isActive = true
        }
        NSLayoutConstraint.activate([
            root.widthAnchor.constraint(equalToConstant: 460),
            stack.leadingAnchor.constraint(equalTo: root.leadingAnchor, constant: 20),
            stack.trailingAnchor.constraint(equalTo: root.trailingAnchor, constant: -20),
            stack.topAnchor.constraint(equalTo: root.topAnchor, constant: 16),
            stack.bottomAnchor.constraint(equalTo: root.bottomAnchor, constant: -18),
        ])
        view = root
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        observation = observe { [weak self] in self?.render() }
        Task { await model.load() }
    }

    override func cancelOperation(_ sender: Any?) { close() }

    private func close() {
        onDone()
        dismiss(nil)
    }

    @objc private func contentChanged() {
        let index = contentPopup.indexOfSelectedItem
        guard model.candidates.indices.contains(index) else { return }
        model.contentId = model.candidates[index].id
    }

    @objc private func dateChanged() { model.date = datePicker.dateValue }

    @objc private func toggleAccount(_ sender: NSButton) {
        guard let id = sender.identifier?.rawValue else { return }
        if sender.state == .on { model.selectedAccounts.insert(id) } else { model.selectedAccounts.remove(id) }
    }

    private func confirmPublishNow() {
        guard let window = view.window else { return }
        let alert = NSAlert()
        alert.messageText = "Şimdi yayınlansın mı?"
        alert.informativeText = model.publishNowConfirmation
        alert.addButton(withTitle: "Yayınla")
        alert.addButton(withTitle: "Vazgeç")
        alert.beginSheetModal(for: window) { [weak self] response in
            guard response == .alertFirstButtonReturn, let self else { return }
            Task { if await self.model.publishNow() { self.close() } }
        }
    }

    private func render() {
        // Post picker (calendar entry point).
        contentPopup.removeAllItems()
        for content in model.candidates {
            contentPopup.addItem(withTitle: "\(content.title) · \(content.status == .approved ? "Onaylı" : content.status.rawValue)")
        }
        if let index = model.candidates.firstIndex(where: { $0.id == model.contentId }) { contentPopup.selectItem(at: index) }
        if datePicker.dateValue != model.date { datePicker.dateValue = model.date }

        accountsStack.arrangedSubviews.forEach { $0.removeFromSuperview() }
        accountsStack.addArrangedSubview(NSTextField.styledLabel("Hesaplar", font: Theme.captionFont, color: Theme.textSecondary))
        if model.accounts.isEmpty {
            accountsStack.addArrangedSubview(NSTextField.styledLabel("Bu postun platformlarında bağlı hesap yok. Ayarlar → Hesaplar'dan bağlayın.", font: Theme.smallFont, color: Theme.textSecondary, wraps: true))
        }
        for account in model.accounts {
            let check = NSButton(checkboxWithTitle: "\(account.platform.displayName) · \(account.handle)", target: self, action: #selector(toggleAccount(_:)))
            check.identifier = NSUserInterfaceItemIdentifier(account.id)
            check.state = model.selectedAccounts.contains(account.id) ? .on : .off
            accountsStack.addArrangedSubview(check)
            if account.status != .connected {
                accountsStack.addArrangedSubview(issueLabel(account.status.label + " — önce yeniden bağlayın.", tone: Theme.accent))
            }
            guard model.selectedAccounts.contains(account.id) else { continue }
            let issues = model.issues(for: account.id)
            for issue in issues.errors { accountsStack.addArrangedSubview(issueLabel("✕ " + issue.message, tone: .systemRed)) }
            for issue in issues.warnings { accountsStack.addArrangedSubview(issueLabel("! " + issue.message, tone: Theme.textSecondary)) }
        }
        if model.isChecking {
            accountsStack.addArrangedSubview(issueLabel("Platform kuralları denetleniyor…", tone: Theme.textSecondary))
        }

        var modeText = app.publishing.modeSummary
        if model.needsApproval { modeText = "Önce bu sürüm onaylanacak. " + modeText }
        modeLabel.stringValue = modeText
        let block = model.dateError ?? model.blockingReason
        blockLabel.stringValue = block ?? ""
        blockLabel.isHidden = block == nil
        if let error = model.error {
            errorBanner.message = error
            errorBanner.isHidden = false
        } else {
            errorBanner.isHidden = true
        }
        scheduleButton.title = model.needsApproval ? "Onayla ve zamanla" : "Zamanla"
        scheduleButton.isEnabled = model.canSchedule
        scheduleButton.showsSpinner = model.isSubmitting
        publishNowButton.isEnabled = model.canPublishNow
    }

    private func issueLabel(_ text: String, tone: NSColor) -> NSTextField {
        let label = NSTextField.styledLabel(text, font: Theme.smallFont, color: tone, wraps: true)
        label.preferredMaxLayoutWidth = 410
        return label
    }
}
