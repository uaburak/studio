import Foundation
import StudioKit

/// The home screen's serif greeting: Turkish, by time of day, with the owner's name.
enum StudioGreeting {
    enum Period: Equatable, CaseIterable {
        case morning, afternoon, evening, night
    }

    /// 05–12 sabah, 12–18 gün, 18–22 akşam, 22–05 gece.
    static func period(hour: Int) -> Period {
        switch ((hour % 24) + 24) % 24 {
        case 5..<12: .morning
        case 12..<18: .afternoon
        case 18..<22: .evening
        default: .night
        }
    }

    /// Two lines per period; the day picks one, so it does not change while the app is open.
    private static func variants(_ period: Period, name: String?) -> [String] {
        let n = name.map { ", \($0)" } ?? ""
        switch period {
        case .morning: return ["Günaydın\(n)", "Güne nereden başlayalım\(n)?"]
        case .afternoon: return ["İyi günler\(n)", "Bugün ne üretelim\(n)?"]
        case .evening: return ["İyi akşamlar\(n)", "Akşam mesaisi mi\(n)?"]
        case .night: return name.map { ["Gece mesaisi mi, \($0)?", "Geç oldu \($0), kısa tutalım mı?"] } ?? ["Gece mesaisi mi?", "Geç oldu, kısa tutalım mı?"]
        }
    }

    static func text(hour: Int, name: String?, variant: Int = 0) -> String {
        let cleaned = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        let options = variants(period(hour: hour), name: cleaned?.isEmpty == false ? cleaned : nil)
        return options[((variant % options.count) + options.count) % options.count]
    }

    static func text(at date: Date, name: String?, calendar: Calendar = .current) -> String {
        let hour = calendar.component(.hour, from: date)
        let day = calendar.ordinality(of: .day, in: .year, for: date) ?? 0
        return text(hour: hour, name: name, variant: day)
    }

    /// The owner's first name from a Mac's name: "Deniz MacBook Pro", "Deniz’s MacBook Air",
    /// "Deniz adlı kişinin MacBook Pro’su", "MacBook Pro (Deniz)". Nil when it cannot tell.
    static func ownerName(fromMacName raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let open = name.firstIndex(of: "("), let close = name[open...].firstIndex(of: ")") {
            return cleanFirstName(String(name[name.index(after: open)..<close]))
        }
        guard let mac = name.range(of: "mac", options: [.caseInsensitive]) else { return nil }
        var prefix = String(name[..<mac.lowerBound])
        for suffix in [" adlı kişinin", "'s", "’s", "'", "’"] where prefix.trimmingCharacters(in: .whitespaces).hasSuffix(suffix) {
            prefix = String(prefix.trimmingCharacters(in: .whitespaces).dropLast(suffix.count))
        }
        prefix = prefix.trimmingCharacters(in: CharacterSet(charactersIn: " -_"))
        return cleanFirstName(prefix)
    }

    private static func cleanFirstName(_ text: String) -> String? {
        let word = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard word.count >= 2, word.count <= 24, !word.contains(" "),
              word.allSatisfy(\.isLetter),
              !["studio", "imac", "mac"].contains(word.lowercased()) else { return nil }
        return word.prefix(1).uppercased(with: TurkishFormat.locale) + word.dropFirst()
    }
}
