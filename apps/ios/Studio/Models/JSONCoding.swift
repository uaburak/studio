import Foundation

/// JSON encoder/decoder configured for the Studio API: timestamps are
/// ISO 8601 UTC strings (`2026-11-16T10:06:31.177Z`), milliseconds optional.
enum StudioJSON {
    static func decoder() -> JSONDecoder {
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

    static func encoder() -> JSONEncoder {
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
enum Timestamp {
    private static let withFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: true, timeZone: .gmt)
    private static let withoutFraction = Date.ISO8601FormatStyle(includingFractionalSeconds: false, timeZone: .gmt)

    static func parse(_ raw: String) -> Date? {
        (try? withFraction.parse(raw)) ?? (try? withoutFraction.parse(raw))
    }

    /// `2026-11-20T07:00:00.000Z`
    static func format(_ date: Date) -> String {
        withFraction.format(date)
    }
}
