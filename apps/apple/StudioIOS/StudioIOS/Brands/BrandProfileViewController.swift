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
final class BrandProfileViewController: UIViewController, UIScrollViewDelegate, DrawerSwipeBlocking {
    private unowned let app: IOSAppModel
    let brandId: EntityID
    let model: BrandPageModel
    private(set) var currentTab: BrandTab

    /// The tabs side by side in the system's own paging scroll view (as Instagram's profile):
    /// the slide, its speed, catching it mid-way and the give at the ends are all UIKit's.
    private let pager = BrandTabPager()
    /// One page per tab, each scrolling on its own and keeping its place.
    private var pages: [BrandTab: BrandTabPage] = [:]
    /// The brand and the tab strip: inside the current page (they scroll away with it), lifted
    /// above the pages while these slide sideways (they stay put, the pages pass under them).
    private let headerBox = UIView()
    private let header = BrandPageHeader()
    private let tabs = BrandTabStrip()
    private var headerHeight: CGFloat = 0
    private weak var headerPage: BrandTabPage?
    /// The same hairline gap between the pages as between Profil's.
    private let pageGap: CGFloat = 1.5
    private var pagerPlaced = false
    /// Where the tab builders put their rows: the stack of the page being built.
    private(set) var body = UIStackView.v([], spacing: 0)
    private var observation: IOSObservationToken?
    private var lastSignature: Int?
    /// The data each page was last built from (a page whose data changed is rebuilt before it
    /// comes into view).
    private var builtSignature: [BrandTab: Int] = [:]
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

        pager.isPagingEnabled = true
        pager.showsHorizontalScrollIndicator = false
        pager.showsVerticalScrollIndicator = false
        pager.alwaysBounceVertical = false
        pager.contentInsetAdjustmentBehavior = .never
        pager.isDirectionalLockEnabled = true
        pager.delegate = self
        pager.shouldBeginPaging = { [weak self] pan in self?.pagerShouldBegin(pan) ?? false }
        view.addSubview(pager)

        for tab in BrandTab.allCases {
            let page = BrandTabPage()
            page.delegate = self
            let refresh = UIRefreshControl()
            refresh.addAction(UIAction { [weak self, weak refresh] _ in
                Task {
                    await self?.model.load()
                    refresh?.endRefreshing()
                }
            }, for: .valueChanged)
            page.refreshControl = refresh
            pager.addSubview(page)
            pages[tab] = page
        }
        body = pages[currentTab]!.stack

        let headerStack = UIStackView.v([header, tabs], spacing: 0)
        headerBox.backgroundColor = IOSTheme.canvas
        headerBox.addSubview(headerStack)
        headerStack.pin(to: headerBox)
        attachHeader(to: pages[currentTab]!)
        setContentScrollView(pages[currentTab], for: .top)

        header.images = app.images
        header.onSelect = { [weak self] in self?.selectBrand() }
        header.onChat = { [weak self] in self?.openChat() }
        header.onCount = { [weak self] tab in self?.show(tab) }
        tabs.onSelect = { [weak self] tab in self?.show(tab) }

        observation = observeIOS { [weak self] in self?.render() }
        Task { await model.load() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        model.flushKit()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        layoutPages()
    }

    /// The pages side by side, the header's height in every page's top inset, and room under a
    /// short tab so a page can always stand with the header scrolled away.
    private func layoutPages() {
        let width = view.bounds.width
        let height = view.bounds.height
        guard width > 0 else { return }
        let span = width + pageGap
        let pagerFrame = CGRect(x: 0, y: 0, width: span, height: height)
        if pager.frame != pagerFrame { pager.frame = pagerFrame }
        pager.contentSize = CGSize(width: span * CGFloat(BrandTab.allCases.count), height: height)
        updateHeaderHeight(width: width)
        let safe = view.safeAreaInsets
        for (tab, page) in pages {
            let frame = CGRect(x: CGFloat(tab.rawValue) * span, y: 0, width: width, height: height)
            if page.frame != frame { page.frame = frame }
            let top = safe.top + headerHeight
            if abs(page.contentInset.top - top) > 0.5, page.refreshControl?.isRefreshing != true {
                let delta = top - page.contentInset.top
                page.contentInset.top = top
                page.verticalScrollIndicatorInsets.top = top
                page.contentOffset.y -= delta
            }
            let bottom = safe.bottom + 40
            if abs(page.contentInset.bottom - bottom) > 0.5 { page.contentInset.bottom = bottom }
            page.minimumContentHeight = max(height - safe.top - bottom, 0)
        }
        if let page = headerPage, abs(headerBox.frame.width - width) > 0.5 || abs(headerBox.frame.height - headerHeight) > 0.5 {
            headerBox.frame = CGRect(x: 0, y: -headerHeight, width: width, height: headerHeight)
            page.layoutIfNeeded()
        }
        if !pagerPlaced || !(pager.isDragging || pager.isDecelerating || isPagerAnimating) {
            pager.contentOffset.x = CGFloat(currentTab.rawValue) * span
            pagerPlaced = true
        }
    }

    private func updateHeaderHeight(width: CGFloat) {
        let size = headerBox.subviews.first?.systemLayoutSizeFitting(
            CGSize(width: width, height: 0), withHorizontalFittingPriority: .required, verticalFittingPriority: .fittingSizeLevel) ?? .zero
        let height = (header.isHidden && tabs.isHidden) ? 0 : ceil(size.height)
        guard abs(height - headerHeight) > 0.5 else { return }
        headerHeight = height
        if headerPage != nil {
            headerBox.frame = CGRect(x: 0, y: -height, width: width, height: height)
        }
    }

    func show(_ next: BrandTab) {
        guard pages[next] != nil else { return }
        let span = view.bounds.width + pageGap
        let target = CGFloat(next.rawValue) * span
        guard abs(pager.contentOffset.x - target) > 0.5 else { return }
        // The pages passed on the way show their rows too.
        let low = min(next.rawValue, currentTab.rawValue), high = max(next.rawValue, currentTab.rawValue)
        for raw in low...high { if let tab = BrandTab(rawValue: raw) { ensureBuilt(tab) } }
        liftHeader()
        isPagerAnimating = true
        pagerTarget = target
        pager.setContentOffset(CGPoint(x: target, y: 0), animated: true)
        Haptics.selection()
    }

    // MARK: Paging

    private var isPagerAnimating = false
    /// Where a tapped tab's slide is going (UIKit can report the end of that animation before
    /// it has even run; only arriving there counts).
    private var pagerTarget: CGFloat?
    private var isPaging: Bool { pager.isDragging || pager.isDecelerating || isPagerAnimating }

    /// Rightward swipes page back while not on the first tab; on Genel they go back a screen.
    var blocksDrawerSwipe: Bool { currentTab != .general || isPaging }

    private func pagerShouldBegin(_ pan: UIPanGestureRecognizer) -> Bool {
        guard model.brand != nil else { return false }
        // A finger landing on a slide still settling catches it (as any scroll view), and the
        // next swipe goes on from there.
        if pager.isDecelerating || isPagerAnimating { return true }
        // The tab strip scrolls sideways itself.
        if tabs.bounds.contains(pan.location(in: tabs)), headerBox.window != nil { return false }
        let velocity = pan.velocity(in: view)
        guard abs(velocity.x) > abs(velocity.y) else { return false }
        // On Genel, a rightward swipe goes back a screen (unless a slide is still settling).
        if velocity.x > 0, pager.contentOffset.x <= 0.5 { return false }
        return true
    }

    private func attachHeader(to page: BrandTabPage) {
        headerBox.removeFromSuperview()
        headerBox.frame = CGRect(x: 0, y: -headerHeight, width: page.bounds.width > 0 ? page.bounds.width : view.bounds.width, height: headerHeight)
        page.addSubview(headerBox)
        headerPage = page
    }

    /// The header leaves the page for the slide, staying where it is on screen; the other pages
    /// line up under it (or, with it scrolled away, keep their own place).
    private func liftHeader() {
        guard let page = headerPage else { return }
        let frame = page.convert(headerBox.frame, to: view)
        headerBox.removeFromSuperview()
        headerBox.frame = frame
        view.insertSubview(headerBox, aboveSubview: pager)
        headerPage = nil
        let safeTop = view.safeAreaInsets.top
        let headerShows = frame.maxY > safeTop + 0.5
        for (tab, other) in pages where other !== page {
            if headerShows {
                other.contentOffset.y = -frame.maxY
            } else if other.contentOffset.y < -safeTop {
                other.contentOffset.y = -safeTop
            }
            _ = tab
        }
        for raw in [currentTab.rawValue - 1, currentTab.rawValue + 1] {
            if let tab = BrandTab(rawValue: raw) { ensureBuilt(tab) }
        }
    }

    /// The slide is over: the page on screen is the current one and takes the header back.
    private func settle() {
        // A tapped tab's slide is over only when it arrives (starting it also reports the end
        // of a glide, and settling then snapped the page back half-way).
        if let target = pagerTarget, abs(pager.contentOffset.x - target) > 1 { return }
        isPagerAnimating = false
        pagerTarget = nil
        let span = max(view.bounds.width + pageGap, 1)
        let index = min(max(Int((pager.contentOffset.x / span).rounded()), 0), BrandTab.allCases.count - 1)
        guard let tab = BrandTab(rawValue: index), let page = pages[tab] else { return }
        if tab != currentTab { Haptics.selection() }
        currentTab = tab
        ensureBuilt(tab)
        if headerPage !== page {
            attachHeader(to: page)
        }
        setContentScrollView(page, for: .top)
        tabs.select(tab, animated: false)
        if renderWaits { render() }
        scheduleNeighbors()
    }

    func scrollViewWillBeginDragging(_ scrollView: UIScrollView) {
        guard scrollView === pager else { return }
        isPagerAnimating = false
        pagerTarget = nil
        // The page under the finger stops scrolling up or down: the swipe is sideways.
        for page in pages.values where page.panGestureRecognizer.state == .began || page.panGestureRecognizer.state == .changed {
            page.panGestureRecognizer.isEnabled = false
            page.panGestureRecognizer.isEnabled = true
        }
        liftHeader()
    }

    func scrollViewDidScroll(_ scrollView: UIScrollView) {
        guard scrollView === pager else { return }
        let span = max(view.bounds.width + pageGap, 1)
        let position = pager.contentOffset.x / span
        tabs.follow(position)
        // Whatever comes into view has its rows (normally built already, beforehand).
        for raw in [Int(position.rounded(.down)), Int(position.rounded(.up))] {
            if let tab = BrandTab(rawValue: raw) { ensureBuilt(tab) }
        }
    }

    func scrollViewDidEndDragging(_ scrollView: UIScrollView, willDecelerate decelerate: Bool) {
        if scrollView === pager, !decelerate { settle() }
    }

    func scrollViewDidEndDecelerating(_ scrollView: UIScrollView) {
        if scrollView === pager { settle() }
    }

    func scrollViewDidEndScrollingAnimation(_ scrollView: UIScrollView) {
        if scrollView === pager { settle() }
    }

    /// Renders even when the model did not change (a picked profile version).
    func renderAgain() {
        lastSignature = nil
        render()
    }

    // MARK: Render

    private func signature() -> Int {
        var hasher = Hasher()
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

    /// A render that came while the pages slide: done when they stop (rebuilding a page under
    /// the finger made it jump).
    private var renderWaits = false

    private func render() {
        if isPaging {
            renderWaits = true
            return
        }
        renderWaits = false
        model.jobsChanged(app.jobBoard.jobs)
        let signature = signature()
        guard signature != lastSignature else { return }
        lastSignature = signature
        title = model.brand?.name ?? "Marka"
        guard let brand = model.brand, let overview = model.overview, let page = pages[currentTab] else {
            header.isHidden = true
            tabs.isHidden = true
            builtSignature = [:]
            guard let page = pages[currentTab] else { return }
            page.stack.removeAllArranged()
            if model.hasLoaded {
                page.stack.addArrangedSubview(BrandUI.inset(BrandUI.footnote("Marka bulunamadı."), top: 24))
            } else {
                let spinner = UIActivityIndicatorView(style: .medium)
                spinner.startAnimating()
                page.stack.addArrangedSubview(BrandUI.inset(spinner, top: 40))
            }
            view.setNeedsLayout()
            return
        }
        header.isHidden = false
        tabs.isHidden = false
        header.configure(
            brand: brand, overview: overview, isCurrent: model.isCurrent,
            counts: [(.products, model.products.products.count, "ürün"), (.templates, model.templates.count, "şablon"), (.kit, model.skills.count, "skill")],
            status: statusLine(), loading: model.isLoading && !model.hasLoaded)
        tabs.select(currentTab, animated: true)
        _ = page
        rebuild(currentTab)
        view.setNeedsLayout()
        view.layoutIfNeeded()
        scheduleNeighbors()
    }

    /// `tab`'s page from the current data (its scroll position stays).
    private func rebuild(_ tab: BrandTab) {
        guard let brand = model.brand, let overview = model.overview, let page = pages[tab] else { return }
        body = page.stack
        if tab == .products { productTiles = [:] }
        UIView.performWithoutAnimation {
            page.stack.removeAllArranged()
            build(tab, brand, overview)
            page.layoutIfNeeded()
        }
        builtSignature[tab] = lastSignature
    }

    private func ensureBuilt(_ tab: BrandTab) {
        guard model.brand != nil, builtSignature[tab] != lastSignature else { return }
        rebuild(tab)
    }

    /// The other tabs, built while the page is still, one per pass and nearest first (building
    /// one as it came into view stalled the slide).
    private func scheduleNeighbors() {
        DispatchQueue.main.async { [weak self] in
            guard let self, !self.isPaging, self.model.brand != nil else { return }
            let next = BrandTab.allCases
                .filter { self.builtSignature[$0] != self.lastSignature }
                .min { abs($0.rawValue - self.currentTab.rawValue) < abs($1.rawValue - self.currentTab.rawValue) }
            guard let next else { return }
            self.rebuild(next)
            self.scheduleNeighbors()
        }
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

/// The tabs' pager: asks before it takes a swipe (a swipe on the tab strip, or rightward on the
/// first tab, is not its).
final class BrandTabPager: UIScrollView, SwipeBackYielding {
    var shouldBeginPaging: ((UIPanGestureRecognizer) -> Bool)?

    /// On the first tab and still, a rightward swipe goes back a screen.
    var yieldsSwipeBack: Bool { contentOffset.x <= 0.5 && !isDragging && !isDecelerating }

    override func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        if gestureRecognizer === panGestureRecognizer, let shouldBeginPaging {
            return shouldBeginPaging(panGestureRecognizer)
        }
        return super.gestureRecognizerShouldBegin(gestureRecognizer)
    }

    /// A finger landing on a page still gliding from a flick stops it here, as the page would
    /// itself, but before the page takes the touch: otherwise the page held it and a sideways
    /// swipe right after a flick did not page.
    override func hitTest(_ point: CGPoint, with event: UIEvent?) -> UIView? {
        if event?.type == .touches {
            for case let page as BrandTabPage in subviews where page.isDecelerating {
                page.stopGliding()
            }
        }
        return super.hitTest(point, with: event)
    }
}

/// One tab's page: its rows in a stack, scrolling on its own under the header.
final class BrandTabPage: UIScrollView {
    let stack = UIStackView.v([], spacing: 0)
    private let container = UIView()
    /// Weak on purpose: it only gives a short tab room below its rows; the rows' stack is not
    /// tied to it (tying it stretched rows apart).
    private lazy var minHeight: NSLayoutConstraint = {
        let constraint = container.heightAnchor.constraint(equalToConstant: 0)
        constraint.priority = .fittingSizeLevel
        return constraint
    }()

    /// At least this tall, so the page can stand with the header scrolled away.
    var minimumContentHeight: CGFloat {
        get { minHeight.constant }
        set { if abs(minHeight.constant - newValue) > 0.5 { minHeight.constant = newValue } }
    }

    init() {
        super.init(frame: .zero)
        contentInsetAdjustmentBehavior = .never
        alwaysBounceVertical = true
        showsHorizontalScrollIndicator = false
        topEdgeEffect.style = .soft
        backgroundColor = IOSTheme.canvas
        container.translatesAutoresizingMaskIntoConstraints = false
        addSubview(container)
        container.addSubview(stack)
        NSLayoutConstraint.activate([
            container.topAnchor.constraint(equalTo: contentLayoutGuide.topAnchor),
            container.leadingAnchor.constraint(equalTo: contentLayoutGuide.leadingAnchor),
            container.trailingAnchor.constraint(equalTo: contentLayoutGuide.trailingAnchor),
            container.bottomAnchor.constraint(equalTo: contentLayoutGuide.bottomAnchor),
            container.widthAnchor.constraint(equalTo: frameLayoutGuide.widthAnchor),
            minHeight,
            stack.topAnchor.constraint(equalTo: container.topAnchor),
            stack.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stack.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
        ])
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    /// Stops a flick's glide where the page is (inside its bounds, if it was bouncing).
    func stopGliding() {
        let top = -adjustedContentInset.top
        let bottom = max(top, contentSize.height + adjustedContentInset.bottom - bounds.height)
        let y = min(max(contentOffset.y, top), bottom)
        setContentOffset(CGPoint(x: contentOffset.x, y: y), animated: false)
    }
}
