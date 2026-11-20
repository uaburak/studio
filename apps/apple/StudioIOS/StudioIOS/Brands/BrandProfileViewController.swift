import StudioKit
import UIKit

/// The sections of a brand's page, as on the Mac's brand page.
enum BrandTab: Int, CaseIterable {
    case general, kit, profile, accounts, products, templates

    var title: String {
        switch self {
        case .general: "Genel"
        case .kit: "Marka Kiti"
        case .profile: "Profil"
        case .accounts: "Hesaplar"
        case .products: "Ürünler"
        case .templates: "Şablonlar"
        }
    }
}

/// One brand, laid out like the Profil screen: the brand's round mark, name and counts, a short
/// "bio" (short name, language, profile state, the voice's opening, the palette) and two wide
/// pills; under it a sideways-scrolling tab strip with an underline for Genel, Marka Kiti,
/// Profil, Hesaplar, Ürünler and Şablonlar. Everything the Mac's brand page does is here:
/// editing goes into sheets (a skill's editor too), the longer lists (checks, special days) and a
/// product's page are pushed.
final class BrandProfileViewController: UIViewController, UIGestureRecognizerDelegate, DrawerSwipeBlocking {
    private unowned let app: IOSAppModel
    let brandId: EntityID
    let model: BrandPageModel
    private(set) var currentTab: BrandTab

    private let scroll = UIScrollView()
    private let header = BrandPageHeader()
    private let tabs = BrandTabStrip()
    /// Where the tab builders put their rows: the page's own stack, or (while the pages slide)
    /// the neighbouring tab's.
    private(set) var body = UIStackView.v([], spacing: 0)
    private lazy var pageBody = body
    private var observation: IOSObservationToken?
    private var lastSignature: Int?
    /// Tiles of the Ürünler tab the product page zooms out of (by product id).
    var productTiles: [EntityID: UIView] = [:]
    /// The profile version picked in Profil (nil: the current one).
    var profileVersion: Int?

    init(app: IOSAppModel, brandId: EntityID, tab: BrandTab = .general) {
        self.app = app
        self.brandId = brandId
        self.currentTab = tab
        self.model = BrandPageModel(app: app, brandId: brandId)
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = IOSTheme.canvas
        navigationItem.largeTitleDisplayMode = .never
        navigationItem.backButtonDisplayMode = .minimal
        let more = UIBarButtonItem(image: UIImage(systemName: "ellipsis"), menu: UIMenu(children: [UIDeferredMenuElement.uncached { [weak self] completion in
            completion(self?.pageMenu() ?? [])
        }]))
        more.accessibilityLabel = "Marka seçenekleri"
        navigationItem.rightBarButtonItem = more

        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.alwaysBounceVertical = true
        scroll.topEdgeEffect.style = .soft
        scroll.contentInset.bottom = 40
        view.addSubview(scroll)
        scroll.pin(to: view)
        setContentScrollView(scroll, for: .top)

        let column = UIStackView.v([header, tabs, pageBody], spacing: 0)
        // The neighbouring tab's page lies beside the column's own, outside its bounds.
        column.clipsToBounds = false
        scroll.addSubview(column)
        NSLayoutConstraint.activate([
            column.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            column.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor),
            column.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor),
            column.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            column.widthAnchor.constraint(equalTo: scroll.frameLayoutGuide.widthAnchor),
        ])

        header.images = app.images
        header.onSelect = { [weak self] in self?.selectBrand() }
        header.onChat = { [weak self] in self?.openChat() }
        header.onCount = { [weak self] tab in self?.show(tab) }
        tabs.onSelect = { [weak self] tab in self?.show(tab) }
        pagePan.delegate = self
        view.addGestureRecognizer(pagePan)
        scroll.panGestureRecognizer.require(toFail: pagePan)

        let refresh = UIRefreshControl()
        refresh.addAction(UIAction { [weak self, weak refresh] _ in
            Task {
                await self?.model.load()
                refresh?.endRefreshing()
            }
        }, for: .valueChanged)
        scroll.refreshControl = refresh

        observation = observeIOS { [weak self] in self?.render() }
        Task { await model.load() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        model.flushKit()
    }

    func show(_ next: BrandTab) {
        guard next != currentTab || pageAnimator != nil else { return }
        slide(to: next)
    }

    // MARK: Paging between tabs (as Profil's Gönderiler / Reels / Hikâyeler)

    private lazy var pagePan = UIPanGestureRecognizer(target: self, action: #selector(paged(_:)))
    private var pageAnimator: UIViewPropertyAnimator?
    private var pageTarget: BrandTab?
    private var pageOffset: CGFloat = 0
    private var panBase: CGFloat = 0
    /// The neighbouring tab's rows beside the page while it slides.
    private var neighborPage: UIStackView?
    private var neighborTab: BrandTab?
    /// -1: the neighbour is to the right (the next tab), 1: to the left, 0: none.
    private var neighborSide: CGFloat = 0
    /// Carries the offset through the animators, so a catch knows where the page is.
    private lazy var pageTracker: UIView = {
        let tracker = UIView()
        tracker.isUserInteractionEnabled = false
        view.insertSubview(tracker, at: 0)
        return tracker
    }()
    /// The same hairline gap between the pages as between Profil's.
    private let pageGap: CGFloat = 1.5

    private var pageHeading: BrandTab { pageAnimator != nil ? (pageTarget ?? currentTab) : currentTab }

    /// Rightward swipes page back while not on the first tab; on Genel they go back a screen.
    var blocksDrawerSwipe: Bool { pageHeading != .general }

    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard gestureRecognizer === pagePan else { return true }
        // The tab strip scrolls sideways itself.
        var view = touch.view
        while let current = view {
            if current === tabs { return false }
            view = current.superview
        }
        return true
    }

    func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        guard gestureRecognizer === pagePan, model.brand != nil else { return gestureRecognizer !== pagePan }
        let velocity = pagePan.velocity(in: view)
        guard abs(velocity.x) > abs(velocity.y) * 1.2 else { return false }
        if velocity.x < 0 { return pageAnimator != nil || currentTab.rawValue < BrandTab.allCases.count - 1 }
        return pageHeading != .general
    }

    @objc private func paged(_ pan: UIPanGestureRecognizer) {
        let width = max(view.bounds.width, 1)
        let dx = pan.translation(in: view).x
        switch pan.state {
        case .began:
            // The distance the finger went before the pan was recognised is not applied at
            // once (the page jumped by it): the page follows from here.
            panBase = interruptPaging() - dx
            pageTarget = nil
        case .changed:
            var offset = panBase + dx
            let last = BrandTab.allCases.count - 1
            if (currentTab == .general && offset > 0) || (currentTab.rawValue == last && offset < 0) { offset *= 0.3 }
            setPage(offset: offset)
        case .ended, .cancelled, .failed:
            let offset = pageOffset
            let velocity = pan.state == .ended ? pan.velocity(in: view).x : 0
            var target = currentTab
            if offset < -width * 0.25 || velocity < -500 {
                target = (neighborSide < 0 ? neighborTab : nil) ?? BrandTab(rawValue: currentTab.rawValue + 1) ?? currentTab
            }
            if offset > width * 0.25 || velocity > 500 {
                target = (neighborSide > 0 ? neighborTab : nil) ?? BrandTab(rawValue: currentTab.rawValue - 1) ?? currentTab
            }
            slide(to: target, from: offset)
        default:
            break
        }
    }

    /// The page's rows moved sideways (the header and the tab strip stay), the neighbouring tab's
    /// glued to their side and the underline following.
    private func setPage(offset: CGFloat) {
        // On whole pixels: a page standing between two pixels draws its words soft, then sharp,
        // then soft again as the finger moves (white titles on pictures shimmered).
        let scale = max(traitCollection.displayScale, 1)
        let offset = (offset * scale).rounded() / scale
        pageOffset = offset
        let move = CGAffineTransform(translationX: offset, y: 0)
        pageBody.transform = move
        pageTracker.transform = move
        let side: CGFloat = offset < 0 ? -1 : (offset > 0 ? 1 : 0)
        if pageTarget == nil, side != 0, side != neighborSide {
            showNeighbor(BrandTab(rawValue: currentTab.rawValue - Int(side)), side: side)
        }
        let span = view.bounds.width + pageGap
        neighborPage?.transform = CGAffineTransform(translationX: offset - neighborSide * span, y: 0)
        let steps = neighborTab.map { CGFloat(abs($0.rawValue - currentTab.rawValue)) } ?? 1
        tabs.follow(CGFloat(currentTab.rawValue) - offset / max(span, 1) * max(steps, 1))
    }

    /// The tabs beside the current one, built while the page is still (building one when the
    /// finger first moves stalled the slide for a few frames).
    private var preparedPages: [BrandTab: UIStackView] = [:]

    private func prepareNeighbors() {
        guard !isPaging else { return }
        for tab in [BrandTab(rawValue: currentTab.rawValue - 1), BrandTab(rawValue: currentTab.rawValue + 1)].compactMap({ $0 })
        where preparedPages[tab] == nil {
            if let stack = makePage(tab) {
                stack.isHidden = true
                preparedPages[tab] = stack
            }
        }
    }

    private func dropPrepared() {
        preparedPages.values.forEach { $0.removeFromSuperview() }
        preparedPages = [:]
    }

    /// `tab`'s rows in their own stack, laid where the page is (hidden until used).
    private func makePage(_ tab: BrandTab) -> UIStackView? {
        guard let brand = model.brand, let overview = model.overview, let column = pageBody.superview else { return nil }
        let stack = UIStackView.v([], spacing: 0)
        stack.translatesAutoresizingMaskIntoConstraints = true
        stack.isUserInteractionEnabled = false
        let savedTiles = productTiles
        body = stack
        UIView.performWithoutAnimation { build(tab, brand, overview) }
        body = pageBody
        productTiles = savedTiles
        let width = pageBody.bounds.width
        let size = stack.systemLayoutSizeFitting(CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel)
        stack.frame = CGRect(x: pageBody.frame.minX, y: pageBody.frame.minY, width: width, height: size.height)
        column.addSubview(stack)
        stack.layoutIfNeeded()
        return stack
    }

    private func showNeighbor(_ tab: BrandTab?, side: CGFloat) {
        dropNeighbor()
        neighborTab = tab
        neighborSide = side
        guard let tab else { return }
        if let prepared = preparedPages.removeValue(forKey: tab) {
            prepared.isHidden = false
            neighborPage = prepared
        } else {
            neighborPage = makePage(tab)
        }
    }

    private func dropNeighbor() {
        // A neighbour still beside the current tab goes back to wait for the next swipe.
        if let page = neighborPage, let tab = neighborTab, abs(tab.rawValue - currentTab.rawValue) == 1, preparedPages[tab] == nil {
            page.isHidden = true
            page.transform = .identity
            preparedPages[tab] = page
        } else {
            neighborPage?.removeFromSuperview()
        }
        neighborPage = nil
        neighborTab = nil
        neighborSide = 0
    }

    /// Stops a running slide where it is; one caught on its way to another tab hands over to it
    /// at once (its page becomes the current one, at the same spot), so a second swipe goes on.
    private func interruptPaging() -> CGFloat {
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(false)
            animator.finishAnimation(at: .current)
            setPage(offset: pageTracker.transform.tx)
            if let target = pageTarget, target != currentTab, neighborTab == target {
                let onScreen = pageOffset - neighborSide * (view.bounds.width + pageGap)
                let previous = currentTab
                pageTarget = nil
                switchTab(to: target)
                if onScreen != 0 { showNeighbor(previous, side: onScreen < 0 ? -1 : 1) }
                setPage(offset: onScreen)
            }
        }
        tabs.select(currentTab, animated: false)
        return pageOffset
    }

    private func switchTab(to tab: BrandTab) {
        currentTab = tab
        dropNeighbor()
        lastSignature = nil
        // Now, even under a finger that caught the slide: this is the tab switch itself.
        forceRender = true
        render()
        forceRender = false
        view.layoutIfNeeded()
    }

    /// To `target`: both pages slide together, side by side, until the other fills the screen;
    /// or back into place. Interruptible at any moment (a new swipe or tap takes over).
    private func slide(to target: BrandTab, from offset: CGFloat? = nil) {
        let start = offset ?? interruptPaging()
        if let animator = pageAnimator {
            pageAnimator = nil
            animator.stopAnimation(true)
        }
        let width = max(view.bounds.width, 1)
        pageTarget = target
        guard target != currentTab else {
            setPage(offset: start)
            let back = UIViewPropertyAnimator(duration: 0.32, dampingRatio: 1) { self.setPage(offset: 0) }
            back.addCompletion { [weak self] position in
                guard let self, position == .end, self.pageAnimator === back else { return }
                self.pageAnimator = nil
                self.pageTarget = nil
                self.dropNeighbor()
                self.tabs.select(self.currentTab, animated: false)
                if self.renderWaits { self.render() }
            }
            pageAnimator = back
            back.startAnimation()
            return
        }
        let side: CGFloat = target.rawValue > currentTab.rawValue ? -1 : 1
        if neighborTab != target || neighborSide != side || neighborPage == nil { showNeighbor(target, side: side) }
        setPage(offset: start)
        let end = side * (width + pageGap)
        let remaining = min(max(abs(end - start) / width, 0.3), 1)
        let across = UIViewPropertyAnimator(duration: 0.38 * remaining, dampingRatio: 1) { self.setPage(offset: end) }
        across.addCompletion { [weak self] position in
            guard let self, position == .end, self.pageAnimator === across else { return }
            self.pageAnimator = nil
            self.pageTarget = nil
            self.switchTab(to: target)
            self.setPage(offset: 0)
        }
        pageAnimator = across
        across.startAnimation()
        Haptics.selection()
    }

    /// Renders even when the model did not change (a picked profile version).
    func renderAgain() {
        lastSignature = nil
        render()
    }

    // MARK: Render

    private func signature() -> Int {
        var hasher = Hasher()
        hasher.combine(currentTab)
        hasher.combine(model.brand)
        hasher.combine(model.kit)
        hasher.combine(model.kitError)
        hasher.combine(model.profiles)
        hasher.combine(model.skills)
        hasher.combine(model.skillsError)
        hasher.combine(model.templates)
        hasher.combine(model.templatesError)
        hasher.combine(model.checks)
        hasher.combine(model.planning)
        hasher.combine(model.products.products)
        hasher.combine(model.products.hasLoaded)
        hasher.combine(model.fontFaces.keys.sorted())
        hasher.combine(model.fontAssets.keys.sorted())
        hasher.combine(model.kitSave)
        hasher.combine(model.settingsSave)
        hasher.combine(model.uploads)
        hasher.combine(model.error)
        hasher.combine(model.hasLoaded)
        hasher.combine(app.currentBrandId == brandId)
        hasher.combine(app.accounts(of: brandId))
        hasher.combine(app.isOnline)
        for job in app.jobBoard.jobs where job.brandId == brandId && !job.status.isTerminal && (job.type == .brandAnalyze || job.type == .brandSkillDraft) {
            hasher.combine(job.id)
            hasher.combine(job.progressMessage)
            hasher.combine(job.progress)
        }
        return hasher.finalize()
    }

    /// A render that came while the pages slide: done when they stop (rebuilding the page under
    /// the finger made it jump; the neighbour's build itself starts loads that change the model).
    private var renderWaits = false
    private var forceRender = false
    private var isPaging: Bool {
        pageAnimator != nil || pagePan.state == .began || pagePan.state == .changed
    }

    private func render() {
        if isPaging, !forceRender {
            renderWaits = true
            return
        }
        renderWaits = false
        model.jobsChanged(app.jobBoard.jobs)
        let signature = signature()
        guard signature != lastSignature else { return }
        lastSignature = signature
        title = model.brand?.name ?? "Marka"
        guard let brand = model.brand, let overview = model.overview else {
            header.isHidden = true
            tabs.isHidden = true
            body.removeAllArranged()
            if model.hasLoaded {
                body.addArrangedSubview(BrandUI.inset(BrandUI.footnote("Marka bulunamadı."), top: 24))
            } else {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.startAnimating()
                body.addArrangedSubview(BrandUI.inset(spinner, top: 40))
            }
            return
        }
        header.isHidden = false
        tabs.isHidden = false
        header.configure(
            brand: brand, overview: overview, isCurrent: model.isCurrent,
            counts: [(.products, model.products.products.count, "ürün"), (.templates, model.templates.count, "şablon"), (.kit, model.skills.count, "skill")],
            status: statusLine(), loading: model.isLoading && !model.hasLoaded)
        if pageAnimator == nil { tabs.select(currentTab, animated: true) }
        productTiles = [:]
        body.removeAllArranged()
        build(currentTab, brand, overview)
        // The neighbours again, from the new data, once this pass is over.
        dropPrepared()
        DispatchQueue.main.async { [weak self] in self?.prepareNeighbors() }
    }

    private func build(_ tab: BrandTab, _ brand: Brand, _ overview: BrandOverview) {
        switch tab {
        case .general: buildGeneral(brand, overview)
        case .kit: buildKit(brand)
        case .profile: buildProfile(brand)
        case .accounts: buildAccounts(overview)
        case .products: buildProducts()
        case .templates: buildTemplates()
        }
    }

    /// What is going on with the brand right now (the analysis, a draft to approve).
    private func statusLine() -> (text: String, attention: Bool)? {
        if let job = model.runningJob(.brandAnalyze) {
            let percent = job.progress.map { " · %\(Int($0 * 100))" } ?? ""
            return ((job.progressMessage ?? "Marka analiz ediliyor…") + percent, true)
        }
        if let draft = model.waitingDraft { return ("Profil taslağı v\(draft.version) onayını bekliyor", true) }
        if model.isArchived { return ("Arşivde: listelerde görünmez", false) }
        return nil
    }

    // MARK: Actions

    private func pageMenu() -> [UIMenuElement] {
        guard let brand = model.brand else { return [] }
        var primary: [UIMenuElement] = []
        if !model.isCurrent && !model.isArchived {
            primary.append(UIAction(title: "Bu markayı seç", image: UIImage(systemName: "checkmark.circle")) { [weak self] _ in self?.selectBrand() })
        }
        primary.append(UIAction(title: "Sohbette konuş", image: UIImage(systemName: "bubble.left.and.text.bubble.right")) { [weak self] _ in self?.openChat() })
        let running = model.runningJob(.brandAnalyze) != nil
        primary.append(UIAction(title: "AI ile analiz et", subtitle: running ? "Sürüyor" : "Örnek postlardan profil taslağı", image: UIImage(systemName: "sparkles"), attributes: running ? .disabled : []) { [weak self] _ in self?.analyze() })
        let edit: [UIMenuElement] = [
            UIAction(title: "Ad, kısa ad ve dil…", image: UIImage(systemName: "pencil")) { [weak self] _ in self?.editBrand() },
        ]
        let archive = UIAction(
            title: brand.status == .archived ? "Arşivden çıkar" : "Arşivle…",
            image: UIImage(systemName: brand.status == .archived ? "tray.and.arrow.up" : "archivebox"),
            attributes: brand.status == .archived ? [] : .destructive) { [weak self] _ in self?.toggleArchive() }
        return [
            UIMenu(options: .displayInline, children: primary),
            UIMenu(options: .displayInline, children: edit),
            UIMenu(options: .displayInline, children: [archive]),
        ]
    }

    func selectBrand() {
        guard !model.isArchived else { return presentError("Arşivdeki marka seçilemez; önce arşivden çıkar.") }
        app.selectBrand(brandId)
        Haptics.success()
        Toast.show("\(model.brand?.name ?? "Marka") seçildi", in: view)
    }

    private func openChat() {
        if !model.isArchived { app.selectBrand(brandId) }
        app.open(.newConversation)
    }

    func analyze() {
        Task {
            if let problem = await model.analyze() {
                presentError(problem, title: "Analiz başlamadı")
            } else {
                Haptics.success()
                Toast.show("Marka analizi başladı; bitince taslak profil onaya düşer.", in: view)
            }
        }
    }

    func editBrand() {
        guard let brand = model.brand else { return }
        let form = BrandFormViewController(mode: .edit(brand)) { [weak self] name, slug, language in
            guard let self else { return "Sayfa kapandı." }
            if let problem = BrandOverview.slugProblem(slug) { return problem }
            if name.trimmingCharacters(in: .whitespaces).isEmpty { return "Marka adı boş olamaz." }
            let input = BrandUpdate(
                name: name == brand.name ? nil : name, slug: slug == brand.slug ? nil : slug,
                defaultLanguage: language == brand.defaultLanguage ? nil : language)
            guard input != BrandUpdate() else { return nil }
            if let problem = await self.model.updateBrand(input) { return problem }
            Toast.show("Marka kaydedildi", in: self.view)
            return nil
        }
        presentSheet(form, detents: [.large()])
    }

    func toggleArchive() {
        guard let brand = model.brand else { return }
        let run = { [weak self] in
            guard let self else { return }
            Task {
                let archiving = brand.status != .archived
                if let problem = await self.model.updateBrand(BrandUpdate(status: archiving ? .archived : .active)) {
                    self.presentError(problem)
                } else {
                    Haptics.success()
                    Toast.show(archiving ? "Marka arşivlendi" : "Marka arşivden çıkarıldı", in: self.view)
                }
            }
        }
        if brand.status == .archived { return run() }
        confirm("\(brand.name) arşivlensin mi?", message: "Marka silinmez; listelerden kalkar, sonra geri getirilebilir.", action: "Arşivle", onConfirm: run)
    }
}

// MARK: - Header

/// The brand at the top, like the Profil screen's header: the mark in a ring (orange while a
/// draft waits or the analysis runs), the name and counts, a bio and two wide pills.
final class BrandPageHeader: UIView {
    var onSelect: (() -> Void)?
    var onChat: (() -> Void)?
    var onCount: ((BrandTab) -> Void)?
    weak var images: IOSImageStore? {
        didSet { if images !== oldValue { rebuildMark() } }
    }

    private let ring = UIView()
    private var mark: BrandMarkView?
    private let nameLabel = UILabel.studio("", size: 17, weight: .semibold, lines: 2, style: .headline)
    private let selectedMark = UIImageView(image: UIImage(systemName: "checkmark.seal.fill"))
    private let spinner = UIActivityIndicatorView(style: .medium)
    private let countStack = UIStackView()
    private let subtitleLabel = UILabel.studio("", size: 14, weight: .semibold, lines: 0, style: .subheadline)
    private let statusLabel = UILabel.studio("", size: 14, color: IOSTheme.accent, lines: 0, style: .subheadline)
    private let bioLabel = UILabel.studio("", size: 14, lines: 3, style: .subheadline)
    private let swatchRow = UIStackView.h([], spacing: 6)
    private let selectButton = UIButton.studioPill(title: "Bu markayı seç", kind: .ink) {}
    private let chatButton = UIButton.studioPill(title: "Sohbette konuş", kind: .secondary) {}

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        ring.translatesAutoresizingMaskIntoConstraints = false
        ring.layer.cornerRadius = 43
        ring.layer.borderWidth = 2.5
        ring.layer.borderColor = IOSTheme.border.cgColor
        NSLayoutConstraint.activate([ring.widthAnchor.constraint(equalToConstant: 86), ring.heightAnchor.constraint(equalToConstant: 86)])
        rebuildMark()

        selectedMark.tintColor = IOSTheme.accent
        selectedMark.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 15, weight: .semibold)
        selectedMark.setContentHuggingPriority(.required, for: .horizontal)
        selectedMark.accessibilityLabel = "Seçili marka"
        selectedMark.isAccessibilityElement = true
        spinner.hidesWhenStopped = true
        countStack.axis = .horizontal
        countStack.distribution = .fillEqually
        countStack.spacing = 8
        let nameRow = UIStackView.h([nameLabel, selectedMark, spinner, UIView.spacer()], spacing: 6)
        let right = UIStackView.v([nameRow, countStack], spacing: 6)
        let top = UIStackView.h([ring, right], spacing: 18, alignment: .center)

        selectButton.addAction(UIAction { [weak self] _ in self?.onSelect?() }, for: .touchUpInside)
        chatButton.addAction(UIAction { [weak self] _ in self?.onChat?() }, for: .touchUpInside)
        let buttons = UIStackView.h([selectButton, chatButton], spacing: 8)
        buttons.distribution = .fillEqually

        let bio = UIStackView.v([subtitleLabel, statusLabel, bioLabel, swatchRow], spacing: 4, alignment: .leading)
        bio.setCustomSpacing(8, after: bioLabel)
        let stack = UIStackView.v([top, bio, buttons], spacing: 12)
        addSubview(stack)
        stack.pin(to: self, insets: UIEdgeInsets(top: 8, left: IOSTheme.gutter, bottom: 14, right: IOSTheme.gutter))
        registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (self: Self, _) in
            self.ring.layer.borderColor = (self.attention ? IOSTheme.accent : IOSTheme.border).cgColor
        }
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    private var attention = false

    private func rebuildMark() {
        mark?.removeFromSuperview()
        let view = BrandMarkView(side: 76, images: images)
        ring.addSubview(view)
        NSLayoutConstraint.activate([view.centerXAnchor.constraint(equalTo: ring.centerXAnchor), view.centerYAnchor.constraint(equalTo: ring.centerYAnchor)])
        mark = view
    }

    func configure(brand: Brand, overview: BrandOverview, isCurrent: Bool, counts: [(BrandTab, Int, String)], status: (text: String, attention: Bool)?, loading: Bool) {
        mark?.configure(overview)
        nameLabel.text = brand.name
        selectedMark.isHidden = !isCurrent
        loading ? spinner.startAnimating() : spinner.stopAnimating()
        attention = status?.attention == true
        ring.layer.borderColor = (attention ? IOSTheme.accent : IOSTheme.border).cgColor

        countStack.removeAllArranged()
        for (tab, count, title) in counts {
            let number = UILabel.studio("\(count)", size: 17, weight: .semibold, style: .headline)
            let label = UILabel.studio(title, size: 14, color: IOSTheme.textSecondary, style: .subheadline)
            let column = UIStackView.v([number, label], spacing: 0)
            column.isUserInteractionEnabled = false
            let control = UIControl()
            control.translatesAutoresizingMaskIntoConstraints = false
            control.addSubview(column)
            column.pin(to: control)
            control.addAction(UIAction { [weak self] _ in self?.onCount?(tab) }, for: .touchUpInside)
            control.isAccessibilityElement = true
            control.accessibilityLabel = "\(count) \(title)"
            control.accessibilityTraits = .button
            countStack.addArrangedSubview(control)
        }

        subtitleLabel.text = "\(overview.subtitle) · \(overview.profileLine)"
        statusLabel.text = status?.text
        statusLabel.textColor = status?.attention == true ? IOSTheme.accent : IOSTheme.textSecondary
        statusLabel.isHidden = status == nil
        bioLabel.text = overview.voice
        bioLabel.isHidden = overview.voice == nil
        swatchRow.removeAllArranged()
        for swatch in overview.swatches {
            let dot = UIView()
            dot.translatesAutoresizingMaskIntoConstraints = false
            dot.backgroundColor = UIColor(hexString: swatch.hex)
            dot.layer.cornerRadius = 9
            dot.layer.borderWidth = 1 / UITraitCollection.current.displayScale
            dot.layer.borderColor = IOSTheme.border.cgColor
            NSLayoutConstraint.activate([dot.widthAnchor.constraint(equalToConstant: 18), dot.heightAnchor.constraint(equalToConstant: 18)])
            dot.isAccessibilityElement = true
            dot.accessibilityLabel = "\(swatch.name) \(swatch.hex)"
            swatchRow.addArrangedSubview(dot)
        }
        swatchRow.isHidden = overview.swatches.isEmpty

        let archived = brand.status == .archived
        selectButton.setPill(title: isCurrent ? "Seçili marka" : (archived ? "Arşivde" : "Bu markayı seç"), kind: isCurrent || archived ? .secondary : .ink, image: isCurrent ? "checkmark" : nil)
        selectButton.isEnabled = !isCurrent && !archived
        chatButton.setPill(title: "Sohbette konuş", kind: .secondary)
    }
}

// MARK: - Tab strip

/// The page's sections as words with a sliding underline; scrolls sideways when they do not fit.
final class BrandTabStrip: UIView {
    var onSelect: ((BrandTab) -> Void)?
    private let scroll = UIScrollView()
    private let row = UIStackView()
    private var buttons: [UIButton] = []
    private let underline = UIView()
    private var selected: BrandTab = .general

    override init(frame: CGRect) {
        super.init(frame: frame)
        translatesAutoresizingMaskIntoConstraints = false
        backgroundColor = IOSTheme.canvas
        heightAnchor.constraint(equalToConstant: 46).isActive = true
        scroll.translatesAutoresizingMaskIntoConstraints = false
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = false
        addSubview(scroll)
        scroll.pin(to: self)
        row.axis = .horizontal
        row.spacing = 4
        row.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(row)
        NSLayoutConstraint.activate([
            row.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            row.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            row.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
            row.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -8),
            row.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
            // Fills the width when the words fit (wide screens), scrolls when they do not.
            row.widthAnchor.constraint(greaterThanOrEqualTo: scroll.frameLayoutGuide.widthAnchor, constant: -16),
        ])
        row.distribution = .fillProportionally
        for tab in BrandTab.allCases {
            var config = UIButton.Configuration.plain()
            config.title = tab.title
            config.contentInsets = NSDirectionalEdgeInsets(top: 10, leading: 10, bottom: 10, trailing: 10)
            let button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.onSelect?(tab) })
            buttons.append(button)
            row.addArrangedSubview(button)
        }
        underline.backgroundColor = IOSTheme.textPrimary
        scroll.addSubview(underline)
        let hairline = BrandUI.hairline()
        addSubview(hairline)
        NSLayoutConstraint.activate([
            hairline.leadingAnchor.constraint(equalTo: leadingAnchor),
            hairline.trailingAnchor.constraint(equalTo: trailingAnchor),
            hairline.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
        select(.general)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Where the underline stands, in tabs (2.5 = halfway between Profil and Hesaplar); the page
    /// drives it, so it moves with the finger and with the page's slide.
    private var position: CGFloat = 0

    func follow(_ position: CGFloat) {
        let last = CGFloat(BrandTab.allCases.count - 1)
        self.position = min(max(position, 0), last)
        if let nearest = BrandTab(rawValue: Int(self.position.rounded())), nearest != selected { select(nearest, animated: false, keepPosition: true, reveal: false) }
        placeUnderline()
        // The words slide too, in step with the underline: the tab being swiped to comes into
        // view as the page does (Şablonlar no longer arrives off screen).
        scroll.layoutIfNeeded()
        scroll.contentOffset.x = stripOffset(at: self.position)
    }

    /// Where the strip stands for `position`: each word as near the middle as the ends allow,
    /// in proportion between two words.
    private func stripOffset(at position: CGFloat) -> CGFloat {
        guard !buttons.isEmpty else { return 0 }
        let maxOffset = max(scroll.contentSize.width - scroll.bounds.width, 0)
        func centered(_ index: Int) -> CGFloat {
            let frame = buttons[index].convert(buttons[index].bounds, to: scroll)
            return min(max(frame.midX - scroll.bounds.width / 2, 0), maxOffset)
        }
        let lower = min(max(Int(position.rounded(.down)), 0), buttons.count - 1)
        let upper = min(lower + 1, buttons.count - 1)
        let t = position - CGFloat(lower)
        let x = centered(lower) + (centered(upper) - centered(lower)) * t
        let scale = max(traitCollection.displayScale, 1)
        return (x * scale).rounded() / scale
    }

    func select(_ tab: BrandTab, animated: Bool = true, keepPosition: Bool = false, reveal: Bool = true) {
        let changed = tab != selected
        selected = tab
        if !keepPosition { position = CGFloat(tab.rawValue) }
        for (index, button) in buttons.enumerated() {
            let on = index == tab.rawValue
            button.configuration?.baseForegroundColor = on ? IOSTheme.textPrimary : IOSTheme.textTertiary
            // One weight for all, so the words keep their widths when the selection moves.
            button.configuration?.titleTextAttributesTransformer = UIConfigurationTextAttributesTransformer { incoming in
                var outgoing = incoming
                outgoing.font = IOSTheme.font(15, .semibold, style: .subheadline)
                return outgoing
            }
            button.accessibilityTraits = on ? [.button, .selected] : .button
        }
        setNeedsLayout()
        guard changed, window != nil else { return }
        if animated {
            UIView.animate(withDuration: 0.25, delay: 0, usingSpringWithDamping: 1, initialSpringVelocity: 0) {
                self.placeUnderline()
            }
        }
        // The picked word comes fully into view when the strip scrolls (not under a dragging
        // finger: the strip would slide on its own as the page moves).
        guard reveal else { return }
        let target = stripOffset(at: CGFloat(tab.rawValue))
        guard abs(scroll.contentOffset.x - target) > 0.5 else { return }
        scroll.setContentOffset(CGPoint(x: target, y: 0), animated: animated)
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // The buttons' frames first (they are laid out inside the scroll view).
        scroll.layoutIfNeeded()
        placeUnderline()
    }

    /// Between the two words around `position`, in proportion.
    private func placeUnderline() {
        guard !buttons.isEmpty else { return }
        let lower = min(max(Int(position.rounded(.down)), 0), buttons.count - 1)
        let upper = min(lower + 1, buttons.count - 1)
        let t = position - CGFloat(lower)
        let a = buttons[lower].convert(buttons[lower].bounds, to: scroll)
        let b = buttons[upper].convert(buttons[upper].bounds, to: scroll)
        let x = a.minX + (b.minX - a.minX) * t
        let w = a.width + (b.width - a.width) * t
        underline.frame = CGRect(x: x + 8, y: bounds.height - 2, width: max(w - 16, 0), height: 2)
    }
}
