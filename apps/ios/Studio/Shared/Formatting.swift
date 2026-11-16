import Foundation

/// Dates are shown in Turkish, in the device time zone.
enum Formatting {
    static let locale = Locale(identifier: "tr_TR")

    /// "20 Kas 2026 10:00"
    static func dateTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale, timeZone: timeZone))
    }

    /// "10:00"
    static func time(_ date: Date, timeZone: TimeZone = .current) -> String {
        date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone))
    }

    /// "20 Kasım 2026 Cuma"
    static func day(_ date: Date, timeZone: TimeZone = .current) -> String {
        date.formatted(
            Date.FormatStyle(locale: locale, timeZone: timeZone).day().month(.wide).year().weekday(.wide))
    }

    /// "3 dakika önce"
    static func relative(_ date: Date, now: Date = .now) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.locale = locale
        formatter.unitsStyle = .full
        if abs(date.timeIntervalSince(now)) < 30 { return "az önce" }
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// "%42"
    static func percent(_ value: Double) -> String {
        value.formatted(.percent.precision(.fractionLength(0)).locale(locale))
    }

    /// "12,4 MB"
    static func bytes(_ count: Int) -> String {
        Int64(count).formatted(.byteCount(style: .file).locale(locale))
    }
}
