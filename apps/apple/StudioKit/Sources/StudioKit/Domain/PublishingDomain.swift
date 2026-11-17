import Foundation

// P3 domain logic shared by the Mac (and later iOS) screens: schedule state in words,
// notification planning, OAuth URLs and callbacks, calendar date math, setup guides.

// MARK: - Schedule state

/// What a schedule means for the owner right now.
public enum ScheduleDisplayState: Hashable, Sendable {
    /// Pending; this Mac publishes it at the time (it must be on).
    case waitingOnMac
    /// Pending, cloud mode, but the order has not reached the cloud yet (or was refused).
    case sendingToCloud(error: String?)
    /// Pending and at the cloud publisher: goes out even if the Mac is off.
    case inCloud
    case publishing
    case published(permalink: String?)
    case failed(reason: String)
    case cancelled

    public init(_ schedule: Schedule, mode: PublishingMode) {
        switch schedule.status {
        case .pending:
            if schedule.delivery == .cloud && schedule.cloudSyncedAt != nil {
                self = .inCloud
            } else if mode == .cloud || schedule.delivery == .cloud {
                self = .sendingToCloud(error: schedule.lastError)
            } else {
                self = .waitingOnMac
            }
        case .publishing: self = .publishing
        case .published: self = .published(permalink: schedule.permalink)
        case .failed: self = .failed(reason: schedule.lastError ?? "Yayın başarısız oldu.")
        case .cancelled, .unknown: self = .cancelled
        }
    }

    public var label: String {
        switch self {
        case .waitingOnMac: "Zamanlandı"
        case .sendingToCloud(let error): error == nil ? "Buluta gönderiliyor" : "Buluta gönderilemedi"
        case .inCloud: "Bulutta"
        case .publishing: "Yayınlanıyor"
        case .published: "Yayınlandı"
        case .failed: "Hata"
        case .cancelled: "İptal edildi"
        }
    }

    /// One line under the label.
    public var detail: String? {
        switch self {
        case .waitingOnMac: "Mac açık olmalı: yayını bu Mac yapacak."
        case .sendingToCloud(let error): error ?? "Bulut yayıncıya aktarılıyor."
        case .inCloud: "Mac kapalı olsa da zamanında paylaşılır."
        case .publishing: "Platforma gönderiliyor."
        case .published: nil
        case .failed(let reason): reason
        case .cancelled: nil
        }
    }

    /// Orange is only for what waits on the owner.
    public var needsOwner: Bool {
        switch self {
        case .failed: true
        case .sendingToCloud(let error): error != nil
        default: false
        }
    }

    public var canCancel: Bool {
        switch self {
        case .waitingOnMac, .sendingToCloud, .inCloud: true
        default: false
        }
    }

    public var canMove: Bool { canCancel }

    public var canRetry: Bool {
        if case .failed = self { return true }
        return false
    }
}

// MARK: - Notifications

public enum NoticeKind: String, Sendable, Hashable {
    case published, publishFailed, jobFinished, jobFailed, tokenExpiring, tokenInvalid
}

/// A user notification the app should post (macOS UserNotifications).
public struct StudioNotice: Equatable, Sendable, Identifiable {
    /// Stable, so the same event is never posted twice.
    public var id: String
    public var kind: NoticeKind
    public var title: String
    public var body: String
    /// The post's permalink, if any.
    public var url: String?
    /// The post the notice is about (clicking it opens the post in the app).
    public var contentId: EntityID?
    public var brandId: EntityID?

    public init(id: String, kind: NoticeKind, title: String, body: String, url: String? = nil,
                contentId: EntityID? = nil, brandId: EntityID? = nil) {
        self.id = id
        self.kind = kind
        self.title = title
        self.body = body
        self.url = url
        self.contentId = contentId
        self.brandId = brandId
    }
}

public enum NoticePlanner {
    /// Published / failed attempts from the publish log feed (`finishedAfter` query).
    public static func notices(for items: [PublishLogFeedItem]) -> [StudioNotice] {
        items.compactMap { item in
            let platform = item.schedule.platform.displayName
            switch item.log.status {
            case .succeeded:
                return StudioNotice(
                    id: "publish:\(item.log.id):ok",
                    kind: .published,
                    title: "Yayınlandı: \(item.contentTitle)",
                    body: "\(platform) · \(item.accountHandle)",
                    url: item.log.permalink ?? item.schedule.permalink,
                    contentId: item.schedule.contentId,
                    brandId: item.schedule.brandId)
            case .failed:
                return StudioNotice(
                    id: "publish:\(item.log.id):failed",
                    kind: .publishFailed,
                    title: "Yayınlanamadı: \(item.contentTitle)",
                    body: "\(platform) · \(item.accountHandle) — \(item.log.error ?? "Bilinmeyen hata")",
                    contentId: item.schedule.contentId,
                    brandId: item.schedule.brandId)
            case .started, .unknown:
                return nil
            }
        }
    }

    /// Long-running jobs the owner waits for; others (chat turns, renders) stay silent.
    public static let notifiedJobTypes: Set<JobType> = [.contentGenerate, .imageGenerate, .brandAnalyze]

    /// A job that just reached a terminal state (`previous` was not terminal).
    public static func notice(for job: Job, previous: JobStatus?) -> StudioNotice? {
        guard notifiedJobTypes.contains(job.type), job.status.isTerminal, previous?.isTerminal != true else { return nil }
        let what: String = switch job.type {
        case .contentGenerate: "Post üretimi"
        case .imageGenerate: "AI görsel"
        case .brandAnalyze: "Marka profili çıkarma"
        default: "İş"
        }
        // A generated post waits for approval: the notice opens it.
        let post = job.type == .contentGenerate ? job.contentId : nil
        switch job.status {
        case .succeeded:
            return StudioNotice(id: "job:\(job.id):ok", kind: .jobFinished, title: "\(what) bitti",
                                body: post == nil ? "Sonuç Studio'da hazır." : "Post onayını bekliyor.",
                                contentId: post, brandId: post == nil ? nil : job.brandId)
        case .failed:
            return StudioNotice(id: "job:\(job.id):failed", kind: .jobFailed, title: "\(what) başarısız", body: job.error ?? "İş tamamlanamadı.",
                                contentId: post, brandId: post == nil ? nil : job.brandId)
        default:
            return nil
        }
    }

    /// Accounts whose token expires within 7 days or is invalid; one notice per account and state per day.
    public static func tokenNotices(accounts: [SocialAccount], now: Date = Date()) -> [StudioNotice] {
        let day = Int(now.timeIntervalSince1970 / 86_400)
        return accounts.compactMap { account in
            guard account.status != .disabled else { return nil }
            let name = "\(account.platform.displayName) · \(account.handle)"
            if account.status == .needsReauth || account.tokenHealth == .invalid {
                return StudioNotice(
                    id: "token:\(account.id):invalid:\(day)", kind: .tokenInvalid,
                    title: "Hesap yeniden bağlanmalı",
                    body: "\(name): erişim anahtarı geçersiz. Ayarlar → Hesaplar'dan yeniden bağlayın.")
            }
            let soon = account.tokenHealth == .expiringSoon
                || (account.tokenExpiresAt.map { $0.timeIntervalSince(now) < 7 * 86_400 } ?? false)
            guard soon else { return nil }
            let left = account.tokenExpiresAt.map { max(0, Int(ceil($0.timeIntervalSince(now) / 86_400))) }
            return StudioNotice(
                id: "token:\(account.id):expiring:\(day)", kind: .tokenExpiring,
                title: "Hesap bağlantısı yakında doluyor",
                body: "\(name): \(left.map { "\($0) gün içinde" } ?? "yakında") yeniden bağlanmalı.")
        }
    }
}

// MARK: - OAuth (loopback redirect on this Mac)

public enum OAuthCallbackError: Error, Equatable, LocalizedError {
    case denied(String)
    case stateMismatch
    case missingCode

    public var errorDescription: String? {
        switch self {
        case .denied(let reason): "Giriş tamamlanmadı: \(reason)"
        case .stateMismatch: "Giriş yanıtı bu oturuma ait değil; yeniden deneyin."
        case .missingCode: "Giriş yanıtında yetki kodu yok; yeniden deneyin."
        }
    }
}

public enum OAuthLoopback {
    /// Fixed so the owner can register it once in the Meta / LinkedIn app.
    public static let port: UInt16 = 8793
    public static let host = "localhost"

    public static func redirectURI(path: String) -> String { "http://\(host):\(port)\(path)" }

    /// Random `state` (CSRF guard).
    public static func newState() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        for i in bytes.indices { bytes[i] = UInt8.random(in: 0...255) }
        return bytes.map { String(format: "%02x", $0) }.joined()
    }

    static func params(_ url: URL) -> [String: String] {
        var out: [String: String] = [:]
        let parts = [URLComponents(url: url, resolvingAgainstBaseURL: false)?.query, url.fragment]
        for part in parts.compactMap({ $0 }) {
            var c = URLComponents()
            c.percentEncodedQuery = part
            for item in c.queryItems ?? [] { out[item.name] = item.value ?? "" }
        }
        return out
    }
}

public enum MetaLogin {
    public static let callbackPath = "/meta/callback"
    public static var redirectURI: String { OAuthLoopback.redirectURI(path: callbackPath) }
    public static let graphVersion = "v27.0"
    /// Pages + Instagram publishing (Facebook Login).
    public static let scopes = [
        "pages_show_list", "pages_read_engagement", "pages_manage_posts",
        "instagram_basic", "instagram_content_publish", "business_management",
    ]

    public struct Callback: Equatable, Sendable {
        public var code: String?
        public var accessToken: String?
        public var expiresIn: Int?
    }

    /// Code flow with an App Secret (long-lived tokens), token flow without one.
    public static func authorizeURL(appId: String, state: String, hasSecret: Bool) -> URL {
        var c = URLComponents(string: "https://www.facebook.com/\(graphVersion)/dialog/oauth")!
        c.queryItems = [
            URLQueryItem(name: "client_id", value: appId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "scope", value: scopes.joined(separator: ",")),
            URLQueryItem(name: "response_type", value: hasSecret ? "code" : "token"),
        ]
        return c.url!
    }

    public static func parseCallback(_ url: URL, expectedState: String) -> Result<Callback, OAuthCallbackError> {
        let p = OAuthLoopback.params(url)
        if let error = p["error_description"] ?? p["error_reason"] ?? p["error"] {
            return .failure(.denied(error.replacingOccurrences(of: "+", with: " ")))
        }
        guard p["state"] == expectedState else { return .failure(.stateMismatch) }
        if let code = p["code"], !code.isEmpty { return .success(Callback(code: code)) }
        if let token = p["access_token"], !token.isEmpty {
            return .success(Callback(accessToken: token, expiresIn: p["expires_in"].flatMap(Int.init)))
        }
        return .failure(.missingCode)
    }
}

public enum LinkedInLogin {
    public static let callbackPath = "/linkedin/callback"
    public static var redirectURI: String { OAuthLoopback.redirectURI(path: callbackPath) }
    /// Sign In with LinkedIn (OpenID Connect) + Share on LinkedIn.
    public static let scopes = ["openid", "profile", "w_member_social"]
    /// LinkedIn member tokens live 60 days; remind a week before.
    public static let tokenLifetimeDays = 60

    public static func authorizeURL(clientId: String, state: String) -> URL {
        var c = URLComponents(string: "https://www.linkedin.com/oauth/v2/authorization")!
        c.queryItems = [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectURI),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
        ]
        return c.url!
    }

    public static func parseCallback(_ url: URL, expectedState: String) -> Result<String, OAuthCallbackError> {
        let p = OAuthLoopback.params(url)
        if let error = p["error_description"] ?? p["error"] {
            return .failure(.denied(error.replacingOccurrences(of: "+", with: " ")))
        }
        guard p["state"] == expectedState else { return .failure(.stateMismatch) }
        guard let code = p["code"], !code.isEmpty else { return .failure(.missingCode) }
        return .success(code)
    }
}

// MARK: - Setup guides (what the owner must create, and where)

public enum PublishingSetupGuide {
    public static let meta: [String] = [
        "developers.facebook.com/apps adresinde “Uygulama oluştur” → kullanım durumu: “Diğer” → tür: “İşletme”.",
        "Ürün ekle: “Facebook Girişi” (Facebook Login for Business değil, klasik giriş) ve “Instagram Graph API”.",
        "Facebook Girişi → Ayarlar → Geçerli OAuth Yönlendirme URI'leri: \(MetaLogin.redirectURI)",
        "Uygulama Ayarları → Temel: Uygulama Kimliği'ni (App ID) ve Uygulama Gizli Anahtarı'nı (App Secret) kopyalayıp aşağıya girin.",
        "Instagram hesabı Profesyonel (İşletme/İçerik üreticisi) olmalı ve bir Facebook Sayfasına bağlı olmalı.",
        "Uygulama “Geliştirme” modunda kalabilir; giriş yapan hesap uygulamada yönetici/geliştirici olmalı. Başkalarının hesapları için Meta uygulama incelemesi gerekir.",
    ]

    public static let linkedIn: [String] = [
        "linkedin.com/developers/apps adresinde “Create app” (bir LinkedIn Sayfası ile ilişkilendirmeniz istenir).",
        "Products sekmesinde “Sign In with LinkedIn using OpenID Connect” ve “Share on LinkedIn” ürünlerini ekleyin.",
        "Auth sekmesi → Authorized redirect URLs: \(LinkedInLogin.redirectURI)",
        "Auth sekmesindeki Client ID ve Client Secret'ı aşağıya girin. Erişim anahtarı 60 gün geçerlidir; Studio bitmeden hatırlatır.",
    ]

    public static let cloud: [String] = [
        "Terminalde apps/cloud-publisher klasöründe README'deki “Kurulum” adımlarını uygulayın (wrangler login, R2 kovası, gizli anahtarlar, wrangler deploy).",
        "PUBLISHER_TOKEN için ürettiğiniz değeri ve Worker'ın adresini (ör. https://publish.burakkoc.net) aşağıya girin.",
        "Kaydedince Studio adresi ve anahtarı dener; onaylanan zamanlamalar buluta gönderilir ve Mac kapalıyken de paylaşılır.",
    ]
}

// MARK: - Calendar date math

public enum CalendarMath {
    /// Monday-first Gregorian calendar in the given time zone.
    public static func calendar(timeZone: TimeZone = .current) -> Calendar {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        cal.timeZone = timeZone
        cal.locale = Locale(identifier: "tr_TR")
        return cal
    }

    /// Start of each day of the week (Mon…Sun) that contains `date`.
    public static func weekDays(containing date: Date, calendar: Calendar = calendar()) -> [Date] {
        let start = calendar.dateInterval(of: .weekOfYear, for: date)?.start ?? calendar.startOfDay(for: date)
        return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
    }

    /// `original`'s local time of day moved to `day` (drag in the month view).
    public static func move(_ original: Date, toDay day: Date, calendar: Calendar = calendar()) -> Date {
        let time = calendar.dateComponents([.hour, .minute], from: original)
        var target = calendar.dateComponents([.year, .month, .day], from: day)
        target.hour = time.hour
        target.minute = time.minute
        return calendar.date(from: target) ?? original
    }

    /// `day` at `hour`, keeping `original`'s minutes (drag onto an hour row in the week view).
    public static func move(_ original: Date, toDay day: Date, hour: Int, calendar: Calendar = calendar()) -> Date {
        let minute = calendar.component(.minute, from: original)
        var target = calendar.dateComponents([.year, .month, .day], from: day)
        target.hour = max(0, min(23, hour))
        target.minute = minute
        return calendar.date(from: target) ?? original
    }

    /// The API refuses times in the past; this is the earliest it accepts with a margin.
    public static func earliestSchedule(now: Date = Date()) -> Date { now.addingTimeInterval(60) }

    /// Default time for a new schedule on `day`: 10:00, or the next half hour when that has passed today.
    public static func defaultTime(on day: Date, now: Date = Date(), calendar: Calendar = calendar()) -> Date {
        var c = calendar.dateComponents([.year, .month, .day], from: day)
        c.hour = 10
        c.minute = 0
        let ten = calendar.date(from: c) ?? day
        if ten > earliestSchedule(now: now) { return ten }
        let minute = calendar.component(.minute, from: now)
        let rounded = calendar.date(byAdding: .minute, value: minute < 30 ? 30 - minute : 60 - minute, to: now) ?? now
        return calendar.date(bySetting: .second, value: 0, of: rounded) ?? rounded
    }
}
