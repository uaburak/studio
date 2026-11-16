import Foundation

/// Any JSON value. Used for the free-form fields of the contract
/// (`Job.payload`, `Job.output`, `BrandProfile.tokens`, `AgentRun.usage`).
public enum JSONValue: Sendable, Hashable, Codable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Double.self) {
            self = .number(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }

    public subscript(key: String) -> JSONValue? {
        if case .object(let object) = self { return object[key] }
        return nil
    }
}

public typealias JSONObject = [String: JSONValue]

/// JSON coding configured for the Studio API: timestamps are ISO 8601 UTC
/// strings (`2026-11-16T10:06:31.177Z`), fractional seconds optional.
public enum StudioJSON {
    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let raw = try container.decode(String.self)
            guard let date = Timestamp.parse(raw) else {
                throw DecodingError.dataCorruptedError(
                    in: container, debugDescription: "expected an ISO 8601 timestamp, got \(raw)")
            }
            return date
        }
        return decoder
    }

    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(Timestamp.format(date))
        }
        return encoder
    }
}

/// The API's timestamp format: ISO 8601, always UTC with a `Z` suffix.
public enum Timestamp {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .gmt)
    private static let withoutFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: false, timeZone: .gmt)

    public static func parse(_ raw: String) -> Date? {
        (try? withFraction.parse(raw)) ?? (try? withoutFraction.parse(raw))
    }

    /// `2026-11-20T07:00:00.000Z`
    public static func format(_ date: Date) -> String {
        withFraction.format(date)
    }
}

/// A `YYYY-MM-DD` calendar day without a time zone (plan dates).
public struct CalendarDay: Sendable, Hashable, Comparable, Codable, CustomStringConvertible {
    public var year: Int
    public var month: Int
    public var day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    public init?(_ raw: String) {
        let parts = raw.split(separator: "-")
        guard parts.count == 3, let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2]),
              (1...12).contains(m), (1...31).contains(d)
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let raw = try container.decode(String.self)
        guard let day = CalendarDay(raw) else {
            throw DecodingError.dataCorruptedError(in: container, debugDescription: "expected YYYY-MM-DD, got \(raw)")
        }
        self = day
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    public var description: String {
        String(format: "%04d-%02d-%02d", year, month, day)
    }

    public static func < (lhs: CalendarDay, rhs: CalendarDay) -> Bool {
        (lhs.year, lhs.month, lhs.day) < (rhs.year, rhs.month, rhs.day)
    }

    /// The day `date` falls on in `timeZone`.
    public init(_ date: Date, in timeZone: TimeZone = .current) {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        self.init(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1)
    }

    /// Midnight of this day in `timeZone`.
    public func date(in timeZone: TimeZone = .current) -> Date {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: year, month: month, day: day)) ?? .distantPast
    }

    public var monthKey: MonthKey { MonthKey(year: year, month: month) }
}

/// A calendar month, e.g. Kasım 2026.
public struct MonthKey: Sendable, Hashable, Comparable, Codable {
    public var year: Int
    public var month: Int

    public init(year: Int, month: Int) {
        self.year = year
        self.month = month
    }

    public init(_ date: Date, in timeZone: TimeZone = .current) {
        let day = CalendarDay(date, in: timeZone)
        self.init(year: day.year, month: day.month)
    }

    public static func < (lhs: MonthKey, rhs: MonthKey) -> Bool {
        (lhs.year, lhs.month) < (rhs.year, rhs.month)
    }

    public var next: MonthKey {
        month == 12 ? MonthKey(year: year + 1, month: 1) : MonthKey(year: year, month: month + 1)
    }

    public var previous: MonthKey {
        month == 1 ? MonthKey(year: year - 1, month: 12) : MonthKey(year: year, month: month - 1)
    }

    /// First day of the month, as a UTC `Date` range bound for API filters.
    public func start(in timeZone: TimeZone = .current) -> Date {
        CalendarDay(year: year, month: month, day: 1).date(in: timeZone)
    }
}
