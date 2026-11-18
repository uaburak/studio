import Foundation

/// Production checks as the apps show them: labels, groups, the summary line and the question
/// before approving. Wording follows the desktop (apps/desktop/src/renderer/features/checks).
public enum ContentChecks {
    /// Short Turkish label of each check id (`CHECK_CATALOG` in content-check.ts).
    public static let labels: [String: String] = [
        "brief.completeness": "Brief eksiksiz",
        "brand.colors": "Marka renkleri",
        "brand.fonts": "Marka fontları",
        "brand.logo": "Logo kullanımı",
        "brand.voice": "Ses tonu ve skill kuralları",
        "layout.overflow": "Metin taşması",
        "layout.safe-area": "Güvenli alan",
        "layout.contrast": "Okunabilirlik kontrastı",
        "layout.legibility": "Yazı boyutu",
        "layout.consistency": "Carousel tutarlılığı",
        "text.caption-length": "Açıklama uzunluğu",
        "text.hashtags": "Hashtag'ler",
        "text.banned-words": "Yasak kelimeler",
        "text.language": "Yazım ve dil bilgisi",
        "accuracy.products": "Ürün adları",
        "accuracy.claims": "İddialar ve rakamlar",
        "visual.resolution": "Çözünürlük",
        "visual.distortion": "Bozulma",
        "visual.logo-legibility": "Logo okunurluğu",
    ]

    /// "Metin taşması" (an id from a newer worker: the id itself).
    public static func label(_ checkId: String) -> String { labels[checkId] ?? checkId }

    /// Counts per status and the results that hold approval back (`summarizeCheckResults`).
    public static func summarize(_ results: [ContentCheckResult], strictness: CheckStrictness) -> (summary: CheckSummary, blocking: Int) {
        var summary = CheckSummary()
        var blocking = 0
        for result in results {
            switch result.status {
            case .pass: summary.pass += 1
            case .warn: summary.warn += 1
            case .fail: summary.fail += 1
            case .fixed: summary.fixed += 1
            case .skipped: summary.skipped += 1
            case .unknown: break
            }
            if isBlocking(result, strictness: strictness) { blocking += 1 }
        }
        return (summary, blocking)
    }

    public static func isBlocking(_ result: ContentCheckResult, strictness: CheckStrictness) -> Bool {
        result.status == .fail || (strictness == .strict && result.status == .warn)
    }

    /// One status group of the list.
    public struct Group: Sendable, Hashable {
        public var status: CheckStatus
        public var results: [ContentCheckResult]
        /// "Başarısız", "Uyarı", "Düzeltildi", "Geçti", "Atlandı".
        public var title: String { status.label }
        /// Problems are shown open; passes and skips folded.
        public var isProblem: Bool { status == .fail || status == .warn || status == .fixed }
    }

    /// Groups in display order (fail, warn, fixed, pass, skipped), each by category step;
    /// empty groups are left out.
    public static func groups(_ run: ContentCheckRun) -> [Group] {
        let order: [CheckStatus] = [.fail, .warn, .fixed, .pass, .skipped]
        return order.compactMap { status in
            let results = run.results.enumerated()
                .filter { $0.element.status == status }
                .sorted { ($0.element.category.step, $0.offset) < ($1.element.category.step, $1.offset) }
                .map(\.element)
            return results.isEmpty ? nil : Group(status: status, results: results)
        }
    }

    /// "2 başarısız · 1 uyarı · 14 geçti" ("Hepsi geçti · …" when clean).
    public static func summaryText(_ run: ContentCheckRun) -> String {
        let s = run.summary
        let parts = [
            s.fail > 0 ? "\(s.fail) başarısız" : nil,
            s.warn > 0 ? "\(s.warn) uyarı" : nil,
            s.fixed > 0 ? "\(s.fixed) düzeltildi" : nil,
            s.pass > 0 ? "\(s.pass) geçti" : nil,
            s.skipped > 0 ? "\(s.skipped) atlandı" : nil,
        ].compactMap { $0 }
        if s.fail == 0, s.warn == 0, s.pass > 0 { return "Hepsi geçti · \(parts.joined(separator: " · "))" }
        return parts.isEmpty ? "Kontrol yok" : parts.joined(separator: " · ")
    }

    /// Worst status of the run.
    public static func overallStatus(_ run: ContentCheckRun) -> CheckStatus {
        let s = run.summary
        if s.fail > 0 { return .fail }
        if s.warn > 0 { return .warn }
        if s.fixed > 0 { return .fixed }
        if s.pass > 0 { return .pass }
        return .skipped
    }

    /// "Slayt 2 · headline", "Slayt 1", "Açıklama", "Brief" (nil: the whole post).
    public static func placeLabel(_ result: ContentCheckResult) -> String? {
        if let ref = result.refs.first {
            if let slide = ref.slide {
                return ref.layer.map { "Slayt \(slide + 1) · \($0)" } ?? "Slayt \(slide + 1)"
            }
            if let layer = ref.layer { return layer }
        }
        if result.checkId.hasPrefix("text.") { return "Açıklama" }
        if result.checkId.hasPrefix("brief.") { return "Brief" }
        return nil
    }

    /// "Metin taşması: Başlık kutusuna sığmıyor." for the results that hold approval back.
    public static func blockingLines(_ run: ContentCheckRun, limit: Int = 5) -> [String] {
        groups(run).flatMap(\.results)
            .filter { isBlocking($0, strictness: run.strictness) }
            .prefix(limit)
            .map { "\(label($0.checkId)): \($0.message)" }
    }

    // MARK: - Approval

    /// What the checks say about approving a version.
    public enum ApprovalGate: Sendable, Hashable {
        /// Checked, nothing holds approval back.
        case clear
        /// The latest run has results that hold approval back.
        case problems(ContentCheckRun)
        /// Checks (or the generation that stores them) are still running.
        case running
        /// The version was never checked.
        case notChecked(version: Int)
        /// The checks could not be read.
        case unavailable(String)

        /// The question before approving (nil: approve right away).
        public var question: (title: String, message: String?)? {
            switch self {
            case .clear:
                return nil
            case .problems(let run):
                let lines = ContentChecks.blockingLines(run)
                return ("Kontrollerde \(run.blocking) sorun var. Yine de onaylansın mı?", lines.isEmpty ? nil : lines.joined(separator: "\n"))
            case .running:
                return ("Kontroller hâlâ sürüyor. Yine de onaylansın mı?", "Sonuç gelmeden onaylarsan sorunları görmeden onaylamış olursun.")
            case .notChecked(let version):
                return ("v\(version) henüz kontrol edilmedi. Yine de onaylansın mı?", "Post detayındaki Kontroller bölümünden kontrolleri çalıştırabilirsin.")
            case .unavailable(let reason):
                return ("Kontroller okunamadı. Yine de onaylansın mı?", reason)
            }
        }
    }

    /// The gate for `version`: its latest run (`run`, nil when never checked) and whether a
    /// check job (or a generation / render of the post) is still running.
    public static func gate(run: ContentCheckRun?, version: Int, running: Bool) -> ApprovalGate {
        if running { return .running }
        guard let run, run.version == version else { return .notChecked(version: version) }
        return run.blocking > 0 ? .problems(run) : .clear
    }

    /// The API refused an approval because of the checks (409 with a check message):
    /// the Turkish line to show, else nil.
    public static func approvalRefusal(_ error: any Error) -> String? {
        guard let api = error as? StudioAPIError, case .server(let status, let code, let message, _) = api,
              status == 409, code != .hashMismatch
        else { return nil }
        let lower = message.lowercased(with: Locale(identifier: "tr_TR"))
        guard lower.contains("check") || lower.contains("kontrol") else { return nil }
        return "Mac onaylamadı: kontrollerde sorun var. (\(message))"
    }
}
