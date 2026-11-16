import Foundation

/// Turkish date and label formatting shared by the apps.
public enum TurkishFormat {
    public static let locale = Locale(identifier: "tr_TR")

    private static func formatter(_ template: String, timeZone: TimeZone) -> DateFormatter {
        let formatter = DateFormatter()
        formatter.locale = locale
        formatter.timeZone = timeZone
        formatter.dateFormat = template
        return formatter
    }

    /// `4 Kas`
    public static func shortDay(_ day: CalendarDay) -> String {
        "\(day.day) \(shortMonthNames[day.month - 1])"
    }

    /// `4 Kas`
    public static func shortDay(_ date: Date, timeZone: TimeZone = .current) -> String {
        shortDay(CalendarDay(date, in: timeZone))
    }

    /// `4 Kasım, 09:00`
    public static func dayAndTime(_ date: Date, timeZone: TimeZone = .current) -> String {
        formatter("d MMMM, HH:mm", timeZone: timeZone).string(from: date)
    }

    /// `4 Kasım`
    public static func longDay(_ day: CalendarDay) -> String {
        "\(day.day) \(monthNames[day.month - 1])"
    }

    /// `Kasım`
    public static func monthName(_ month: MonthKey) -> String {
        monthNames[month.month - 1]
    }

    /// `Kasım 2026` (year only when it is not `currentYear`).
    public static func monthTitle(_ month: MonthKey, currentYear: Int) -> String {
        month.year == currentYear ? monthName(month) : "\(monthName(month)) \(month.year)"
    }

    public static let monthNames = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"]
    public static let shortMonthNames = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"]

    /// Turkish-aware uppercase (`bilgi` -> `BİLGİ`).
    public static func upper(_ text: String) -> String {
        text.uppercased(with: locale)
    }

    /// `şimdi`, `2 dk`, `1 sa`, `3 gün`.
    public static func elapsed(from start: Date, to now: Date) -> String {
        let seconds = max(0, now.timeIntervalSince(start))
        switch seconds {
        case ..<60: return "şimdi"
        case ..<3600: return "\(Int(seconds / 60)) dk"
        case ..<86_400: return "\(Int(seconds / 3600)) sa"
        default: return "\(Int(seconds / 86_400)) gün"
        }
    }

    /// `4:5`, `1:1`, `9:16` from pixel dimensions.
    public static func ratio(width: Int, height: Int) -> String {
        func gcd(_ a: Int, _ b: Int) -> Int { b == 0 ? a : gcd(b, a % b) }
        guard width > 0, height > 0 else { return "" }
        let divisor = gcd(width, height)
        return "\(width / divisor):\(height / divisor)"
    }

    /// `Tek görsel · 4:5`, `Carousel · 5 slayt · 4:5`, `Story · 9:16`, `Reels`.
    public static func typeLabel(_ type: ContentType, slides: [Slide]) -> String {
        let ratio = slides.first.map { self.ratio(width: $0.width, height: $0.height) }
        var parts: [String]
        switch type {
        case .post: parts = ["Tek görsel"]
        case .carousel: parts = ["Carousel"] + (slides.count > 1 ? ["\(slides.count) slayt"] : [])
        case .story: parts = ["Story"]
        case .reel: parts = ["Reels"]
        case .unknown: parts = ["İçerik"]
        }
        if let ratio, !ratio.isEmpty { parts.append(ratio) }
        return parts.joined(separator: " · ")
    }

    public static func platforms(_ platforms: [Platform]) -> String {
        platforms.isEmpty ? "Seçilmedi" : platforms.map(\.displayName).joined(separator: ", ")
    }
}
