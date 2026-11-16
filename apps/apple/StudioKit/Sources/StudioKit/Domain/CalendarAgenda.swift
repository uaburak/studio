import Foundation

/// One row of the calendar: a schedule, or a dated post without one.
public struct CalendarEntry: Identifiable, Hashable, Sendable {
    public enum Kind: String, Hashable, Sendable {
        case scheduled, publishing, published, failed, approved, planned
    }

    public var id: String
    public var day: CalendarDay
    /// Exact time for schedules; plan days use 09:00.
    public var date: Date
    public var timeText: String
    public var title: String
    public var platformText: String
    public var accountHandle: String?
    public var statusLabel: String
    public var kind: Kind
    public var permalink: String?
    public var schedule: Schedule?
    public var contentId: EntityID

    /// Pending schedules can be cancelled and moved to another time.
    public var canCancel: Bool { schedule?.status == .pending }
    public var canReschedule: Bool { schedule?.status == .pending }
    public var scheduleId: EntityID? { schedule?.id }
}

/// The calendar screen's logic, shared by the apps: entries of a brand's schedules and
/// dated posts, the Monday-first month grid, and rescheduling.
public enum CalendarAgenda {
    public static let weekdaySymbols = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"]

    /// Every entry, sorted by day, time and title. Posts that already have a schedule on
    /// their day show only the schedule row.
    public static func entries(
        schedules: [Schedule], contents: [Content], accounts: [SocialAccount], cards: [PostCard],
        timeZone: TimeZone = .current
    ) -> [CalendarEntry] {
        let contentById = Dictionary(contents.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let accountById = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let time = DateFormatter()
        time.locale = TurkishFormat.locale
        time.timeZone = timeZone
        time.dateFormat = "HH:mm"

        var entries: [CalendarEntry] = []
        var scheduledDays = Set<String>()
        for schedule in schedules where schedule.status != .cancelled && schedule.status != .unknown {
            let day = CalendarDay(schedule.scheduledAt, in: timeZone)
            let account = accountById[schedule.socialAccountId]
            let handle = account.map { $0.handle.hasPrefix("@") || $0.handle.contains(" ") ? $0.handle : "@\($0.handle)" }
            let (label, kind): (String, CalendarEntry.Kind) = switch schedule.status {
            case .pending: ("Zamanlandı", .scheduled)
            case .publishing: ("Yayınlanıyor", .publishing)
            case .published: ("Yayınlandı", .published)
            case .failed: ("Yayın hatası", .failed)
            case .cancelled, .unknown: ("İptal", .planned)
            }
            scheduledDays.insert("\(schedule.contentId):\(day)")
            entries.append(CalendarEntry(
                id: "sch-\(schedule.id)", day: day, date: schedule.scheduledAt,
                timeText: time.string(from: schedule.scheduledAt),
                title: contentById[schedule.contentId]?.title ?? cards.first { $0.id == schedule.contentId }?.title ?? "Post",
                platformText: schedule.platform.displayName, accountHandle: handle, statusLabel: label, kind: kind,
                permalink: schedule.permalink, schedule: schedule, contentId: schedule.contentId))
        }
        for card in cards {
            guard let day = card.day, !scheduledDays.contains("\(card.id):\(day)") else { continue }
            let (label, kind): (String, CalendarEntry.Kind) = switch card.state {
            case .published: ("Yayınlandı", .published)
            case .scheduled: ("Zamanlandı", .scheduled)
            case .publishing: ("Yayınlanıyor", .publishing)
            case .approved: ("Onaylandı", .approved)
            case .failed: ("Yayın hatası", .failed)
            default: (card.state.label, .planned)
            }
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = timeZone
            let date = calendar.date(from: DateComponents(year: day.year, month: day.month, day: day.day, hour: 9)) ?? day.date()
            entries.append(CalendarEntry(
                id: "card-\(card.id)", day: day, date: date, timeText: "09:00", title: card.title,
                platformText: TurkishFormat.platforms(card.content.targetPlatforms), accountHandle: nil,
                statusLabel: label, kind: kind, permalink: nil, schedule: nil, contentId: card.id))
        }
        return entries.sorted { a, b in
            if a.day != b.day { return a.day < b.day }
            if a.date != b.date { return a.date < b.date }
            return a.title < b.title
        }
    }

    /// Cells of `month` starting Monday; nil = blank cell before the 1st / after the last day.
    public static func monthGrid(_ month: MonthKey) -> [CalendarDay?] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let first = calendar.date(from: DateComponents(year: month.year, month: month.month, day: 1)) ?? Date()
        let weekday = calendar.component(.weekday, from: first) // 1 = Sunday
        let leading = (weekday + 5) % 7
        let count = calendar.range(of: .day, in: .month, for: first)?.count ?? 30
        var cells: [CalendarDay?] = Array(repeating: nil, count: leading)
        for day in 1...count { cells.append(CalendarDay(year: month.year, month: month.month, day: day)) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return cells
    }

    /// Months that have entries, ascending.
    public static func months(_ entries: [CalendarEntry]) -> [MonthKey] {
        Set(entries.map(\.day.monthKey)).sorted()
    }
}

extension StudioDataService {
    /// Move a pending schedule to `date`. Uses the API's reschedule route when the
    /// connection has one; otherwise cancels and books the same post on the same account
    /// again (one active schedule per post and account), restoring the old time if the
    /// new one is refused.
    public func moveSchedule(_ schedule: Schedule, to date: Date) async throws -> Schedule {
        guard schedule.status == .pending else {
            throw StudioAPIError.invalidConfiguration("Yalnızca bekleyen zamanlamalar taşınabilir.")
        }
        guard date > Date().addingTimeInterval(60) else {
            throw StudioAPIError.invalidConfiguration("Yeni zaman gelecekte olmalı.")
        }
        do {
            return try await reschedule(schedule.id, to: date)
        } catch let error as StudioAPIError {
            switch error {
            case .invalidConfiguration: break // this connection has no reschedule route
            case .server(let status, _, _, _) where status == 404 || status == 405: break
            default: throw error
            }
        }
        _ = try await cancelSchedule(schedule.id)
        do {
            return try await createSchedule(ScheduleCreate(
                contentId: schedule.contentId, socialAccountId: schedule.socialAccountId,
                platform: schedule.platform, scheduledAt: date))
        } catch {
            if schedule.scheduledAt > Date().addingTimeInterval(30) {
                _ = try? await createSchedule(ScheduleCreate(
                    contentId: schedule.contentId, socialAccountId: schedule.socialAccountId,
                    platform: schedule.platform, scheduledAt: schedule.scheduledAt))
            }
            throw error
        }
    }
}
