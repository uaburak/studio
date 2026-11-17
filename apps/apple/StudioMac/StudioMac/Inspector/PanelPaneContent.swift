import Foundation
import StudioKit

// The right panel's Takvim, Medya and Marka panes as plain values (tested without views).

// MARK: - Takvim

/// The Takvim pane: a compact month (Monday first) with a dot per kind of post on each day, and
/// the selected day's agenda under it (time, platform, title, status).
struct MiniCalendar: Equatable {
    typealias DotKind = CalendarModel.CalendarEntry.DotKind

    struct Cell: Equatable {
        /// nil: a blank cell before the 1st or after the last day.
        var day: CalendarDay?
        var isToday: Bool
        var isSelected: Bool
        /// One dot per kind of post that day, in a stable order (at most three).
        var dots: [DotKind]
        var count: Int
    }

    struct AgendaItem: Equatable {
        var id: String
        /// "09:30" ("—" for a dated post without a schedule).
        var time: String
        var platform: Platform?
        /// "Instagram" or "Instagram, Facebook".
        var platformText: String
        var title: String
        var status: String
        var dot: DotKind
        var contentId: EntityID?
        var scheduleId: EntityID?
        /// A pending schedule: it can be dragged onto another day.
        var canMove: Bool
        /// Failed / refused: waiting on the owner (accent).
        var needsOwner: Bool
    }

    static let weekdayLabels = ["Pzt", "Sal", "Çar", "Per", "Cum", "Cmt", "Paz"]
    private static let dotOrder: [DotKind] = [.error, .scheduled, .approved, .planned, .published]
    static let maxDots = 3

    var month: MonthKey
    /// "Kasım 2026".
    var title: String
    /// Rows of seven.
    var cells: [Cell]
    var selected: CalendarDay?
    /// "17 Kasım Salı" (nil: no day selected in this month).
    var agendaTitle: String?
    var agenda: [AgendaItem]

    var weeks: [[Cell]] {
        stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<min($0 + 7, cells.count)]) }
    }

    @MainActor
    static func make(month: MonthKey, selected: CalendarDay?, entries: [CalendarModel.CalendarEntry], today: CalendarDay) -> MiniCalendar {
        let byDay = Dictionary(grouping: entries.filter { $0.day.monthKey == month }, by: \.day)
        let cells = CalendarModel.monthGridDays(for: month).map { day -> Cell in
            guard let day else { return Cell(day: nil, isToday: false, isSelected: false, dots: [], count: 0) }
            let dayEntries = byDay[day] ?? []
            let kinds = Set(dayEntries.map(\.dotKind))
            return Cell(
                day: day,
                isToday: day == today,
                isSelected: day == selected,
                dots: Array(dotOrder.filter(kinds.contains).prefix(maxDots)),
                count: dayEntries.count
            )
        }
        let shownDay = selected.flatMap { $0.monthKey == month ? $0 : nil }
        let agenda = shownDay.map { day in
            (byDay[day] ?? []).map { entry in
                AgendaItem(
                    id: entry.id,
                    time: entry.timeText,
                    platform: entry.platform,
                    platformText: entry.platformText,
                    title: entry.title,
                    status: entry.statusLabel,
                    dot: entry.dotKind,
                    contentId: entry.contentId,
                    scheduleId: entry.scheduleId,
                    canMove: entry.canMove,
                    needsOwner: entry.state?.needsOwner == true
                )
            }
        } ?? []
        return MiniCalendar(
            month: month,
            title: "\(TurkishFormat.monthName(month)) \(month.year)",
            cells: cells,
            selected: shownDay,
            agendaTitle: shownDay.map(dayTitle),
            agenda: agenda
        )
    }

    /// "17 Kasım Salı".
    static func dayTitle(_ day: CalendarDay) -> String {
        "\(TurkishFormat.longDay(day)) \(weekdayName(day))"
    }

    static func weekdayName(_ day: CalendarDay) -> String {
        let names = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"]
        let weekday = Calendar(identifier: .gregorian).component(.weekday, from: day.date())
        return names[(weekday - 1 + 7) % 7]
    }

    /// The day the pane selects in `month`: today when it is in that month, else the first day
    /// with posts, else the 1st.
    static func defaultDay(in month: MonthKey, entries: [CalendarModel.CalendarEntry], today: CalendarDay) -> CalendarDay {
        if today.monthKey == month { return today }
        return entries.filter { $0.day.monthKey == month }.map(\.day).min() ?? CalendarDay(year: month.year, month: month.month, day: 1)
    }
}

// MARK: - Medya

/// The Medya pane's grid: the brand's media, newest first, filtered by the search field
/// (file name, kind, "AI" for generated pictures; Turkish-aware like the settings search).
enum MediaPaneContent {
    static let columns = 3
    static let spacing: CGFloat = 6

    static func filter(_ assets: [Asset], query: String) -> [Asset] {
        let sorted = assets.sorted { $0.createdAt > $1.createdAt }
        guard !SettingsSearch.tokens(query).isEmpty else { return sorted }
        return sorted.filter { SettingsSearch.matches(query, in: searchText($0)) }
    }

    static func searchText(_ asset: Asset) -> String {
        var words = [asset.originalFilename ?? "", asset.kind.label, asset.mimeType]
        if asset.source == .generated { words.append("ai yapay zeka üretilen") }
        if asset.kind == .logo { words.append("logo") }
        return words.joined(separator: " ")
    }

    /// Square tiles: their side for a grid `width` wide.
    static func tileSide(width: CGFloat) -> CGFloat {
        let columns = CGFloat(Self.columns)
        return max(0, floor((width - spacing * (columns - 1)) / columns))
    }

    /// Height of a grid of `count` tiles `width` wide.
    static func gridHeight(count: Int, width: CGFloat) -> CGFloat {
        guard count > 0 else { return 0 }
        let rows = CGFloat((count + columns - 1) / columns)
        return rows * tileSide(width: width) + (rows - 1) * spacing
    }

    /// Images (and logos) can be previewed and dragged into the composer.
    static func isImage(_ asset: Asset) -> Bool {
        asset.kind == .image || asset.kind == .logo
    }
}

// MARK: - Marka

/// The Marka pane's card, from the brand, its kit, its current profile and its accounts.
/// The approved profile's tokens win over the raw kit for colours and fonts.
struct BrandCardContent: Equatable {
    struct Swatch: Equatable {
        var name: String
        /// `#RRGGBB`.
        var hex: String
    }

    struct PlatformLine: Equatable {
        var platform: Platform
        /// "@mtmagro", "Bağlı değil", "Yeniden bağla".
        var value: String
        var connected: Bool
        var needsOwner: Bool
    }

    var name: String
    /// "mtm-agro · Türkçe".
    var subtitle: String
    var initials: String
    var logoAssetId: EntityID?
    /// "Onaylı profil · v3", "Taslak profil · v1", "Profil yok".
    var profileLine: String
    var swatches: [Swatch]
    /// "Archivo (Başlık) · Inter (Gövde)".
    var fonts: [String]
    /// The first sentences of the voice text (nil: no voice written yet).
    var voice: String?
    var platforms: [PlatformLine]

    static let maxSwatches = 8
    static let voiceLimit = 220

    static func make(brand: Brand, kit: BrandKit?, profile: BrandProfile?, accounts: [SocialAccount]) -> BrandCardContent {
        let rows = profile.map { ProfileTokens.rows($0.tokens) } ?? []
        var swatches = rows.filter { $0.kind == .color && $0.group == "Renkler" }.compactMap { row -> Swatch? in
            guard let hex = BrandKitRules.normalizedHex(row.value) else { return nil }
            return Swatch(name: row.label, hex: hex)
        }
        if swatches.isEmpty {
            swatches = (kit?.palette ?? []).compactMap { color in
                BrandKitRules.normalizedHex(color.hex).map { Swatch(name: color.name, hex: $0) }
            }
        }
        var fonts = rows.filter { $0.path.last == "family" }.map { "\($0.value) (\($0.label.replacingOccurrences(of: " ailesi", with: "")))" }
        if fonts.isEmpty {
            var seen = Set<String>()
            fonts = (kit?.fonts ?? []).compactMap { font in
                let family = font.family.trimmingCharacters(in: .whitespaces)
                guard !family.isEmpty, seen.insert(family.lowercased()).inserted else { return nil }
                return font.role == .any || font.role == .unknown ? family : "\(family) (\(font.role.label))"
            }
        }
        let profileLine: String = if let profile {
            profile.status == .approved ? "Onaylı profil · v\(profile.version)" : "\(profile.status.label) profil · v\(profile.version)"
        } else {
            "Profil yok"
        }
        let logo = kit?.logos.first { $0.background != .dark } ?? kit?.logos.first
        return BrandCardContent(
            name: brand.name,
            subtitle: "\(brand.slug) · \(BrandLanguage.label(brand.defaultLanguage))",
            initials: initials(brand.name),
            logoAssetId: logo?.assetId,
            profileLine: profileLine,
            swatches: Array(swatches.prefix(maxSwatches)),
            fonts: fonts,
            voice: profile.flatMap { summary($0.voice) },
            platforms: Platform.knownCases.map { platform in line(platform, accounts: accounts) }
        )
    }

    static func line(_ platform: Platform, accounts: [SocialAccount]) -> PlatformLine {
        let candidates = accounts.filter { $0.platform == platform && $0.status != .disabled }
        guard let account = candidates.first(where: { $0.status == .connected }) ?? candidates.first else {
            return PlatformLine(platform: platform, value: "Bağlı değil", connected: false, needsOwner: false)
        }
        let handle = account.handle.trimmingCharacters(in: .whitespaces)
        let shown = handle.isEmpty ? "Bağlı" : (platform == .instagram && !handle.hasPrefix("@") ? "@\(handle)" : handle)
        switch account.status {
        case .connected:
            let needs = TokenHealthText.needsOwner(account)
            return PlatformLine(platform: platform, value: needs ? (account.tokenHealth?.label ?? "Kontrol et") : shown, connected: true, needsOwner: needs)
        case .needsReauth:
            return PlatformLine(platform: platform, value: "Yeniden bağla", connected: false, needsOwner: true)
        default:
            return PlatformLine(platform: platform, value: account.status.label, connected: false, needsOwner: false)
        }
    }

    /// "MTM Agro" → "MA", "Finvo" → "F".
    static func initials(_ name: String) -> String {
        let words = name.split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let letters = words.prefix(2).compactMap(\.first).map { String($0).uppercased(with: TurkishFormat.locale) }
        return letters.isEmpty ? "?" : letters.joined()
    }

    /// The voice text's opening (markdown headings and bullets dropped), at most `voiceLimit` characters.
    static func summary(_ voice: String) -> String? {
        let lines = voice.split(separator: "\n").map { line -> String in
            var text = line.trimmingCharacters(in: .whitespaces)
            while let first = text.first, "#-*>".contains(first) { text = String(text.dropFirst()).trimmingCharacters(in: .whitespaces) }
            return text
        }.filter { !$0.isEmpty }
        let joined = lines.joined(separator: " ")
        guard !joined.isEmpty else { return nil }
        guard joined.count > voiceLimit else { return joined }
        let cut = joined.prefix(voiceLimit)
        if let end = cut.lastIndex(where: { ".!?".contains($0) }), cut.distance(from: cut.startIndex, to: end) > voiceLimit / 2 {
            return String(cut[...end])
        }
        return cut.trimmingCharacters(in: .whitespaces) + "…"
    }
}

extension Platform {
    /// A neutral line symbol for the platform (SF Symbols has no brand logos).
    var panelSymbol: String {
        switch self {
        case .instagram: "camera"
        case .facebook: "f.square"
        case .linkedin: "briefcase"
        case .unknown: "globe"
        }
    }
}
