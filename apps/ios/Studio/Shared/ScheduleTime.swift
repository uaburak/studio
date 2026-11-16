import Foundation

/// Publish times: the user picks a wall-clock time in the device time zone;
/// the API stores UTC (`ScheduleCreate.scheduledAt`, "Must be in the future.
/// Use UTC (`...Z`)").
enum ScheduleTime {
    /// Schedules closer than this are refused locally, so the request does not
    /// race the clock and fail with "must be in the future".
    static let minimumLead: TimeInterval = 2 * 60

    enum ValidationError: Error, Equatable, LocalizedError {
        case inPast
        case tooSoon

        var errorDescription: String? {
            switch self {
            case .inPast: "Seçilen zaman geçmişte kalıyor."
            case .tooSoon: "Paylaşım zamanı en az 2 dakika sonrası olmalı."
            }
        }
    }

    /// Instant for a wall-clock time in `timeZone`. A time that does not exist
    /// (skipped by a DST jump) moves forward to the first valid instant.
    static func instant(_ components: DateComponents, in timeZone: TimeZone) -> Date? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        var wall = DateComponents()
        wall.year = components.year
        wall.month = components.month
        wall.day = components.day
        wall.hour = components.hour ?? 0
        wall.minute = components.minute ?? 0
        wall.second = 0
        return calendar.date(from: wall)
    }

    /// Wall-clock parts of `date` in `timeZone`.
    static func wallClock(_ date: Date, in timeZone: TimeZone) -> DateComponents {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
    }

    /// The value sent to the API: `2026-11-20T07:00:00.000Z`.
    static func utcString(_ date: Date) -> String {
        Timestamp.format(date)
    }

    static func validate(_ date: Date, now: Date = .now) -> ValidationError? {
        if date <= now { return .inPast }
        if date.timeIntervalSince(now) < minimumLead { return .tooSoon }
        return nil
    }

    /// Drops seconds so "10:00" means 10:00:00.
    static func truncatedToMinute(_ date: Date) -> Date {
        Date(timeIntervalSince1970: (date.timeIntervalSince1970 / 60).rounded(.down) * 60)
    }

    /// "GMT+3 · Europe/Istanbul" for showing which zone the picker uses.
    static func zoneDescription(_ timeZone: TimeZone, at date: Date = .now) -> String {
        let seconds = timeZone.secondsFromGMT(for: date)
        let hours = seconds / 3600
        let minutes = abs(seconds % 3600) / 60
        let offset = minutes == 0
            ? String(format: "GMT%+d", hours)
            : String(format: "GMT%+d:%02d", hours, minutes)
        return "\(offset) · \(timeZone.identifier)"
    }
}
