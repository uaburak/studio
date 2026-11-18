import Foundation

// Publishing domain logic for the apps: schedule state in words, notification planning,
// calendar date math. (Connecting Meta / LinkedIn runs in the desktop app, apps/desktop.)

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
