import Foundation

/// The single error type every StudioKit network call throws.
public enum StudioAPIError: Error, Sendable, Equatable, LocalizedError {
    /// The API answered with its error shape (`ApiErrorBody`).
    case server(status: Int, code: APIErrorCode, message: String, issues: [APIErrorBody.Issue])
    /// 401/403 without the API error shape: Cloudflare Access refused the credentials.
    case unauthorized(status: Int)
    /// Non-2xx without the API error shape (proxy, gateway, ...).
    case http(status: Int)
    /// 2xx that is not the expected JSON, e.g. an Access login page (HTML).
    case unexpectedResponse(String)
    /// The JSON did not match the contract.
    case decoding(String)
    /// No network, or the server cannot be reached.
    case offline
    case timedOut
    case transport(String)
    /// Base URL missing or malformed.
    case invalidConfiguration(String)
    case cancelled

    public static func from(_ error: any Error) -> StudioAPIError {
        if let error = error as? StudioAPIError { return error }
        if error is CancellationError { return .cancelled }
        if let error = error as? URLError { return from(error) }
        if let error = error as? DecodingError { return .decoding(describe(error)) }
        return .transport(error.localizedDescription)
    }

    public static func from(_ error: URLError) -> StudioAPIError {
        switch error.code {
        case .cancelled:
            return .cancelled
        case .timedOut:
            return .timedOut
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
             .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed, .callIsActive:
            return .offline
        case .appTransportSecurityRequiresSecureConnection:
            return .invalidConfiguration("Bu adres için https gerekiyor.")
        case .userAuthenticationRequired:
            return .unauthorized(status: 401)
        default:
            return .transport(error.localizedDescription)
        }
    }

    /// Build the error for a non-2xx response.
    public static func from(status: Int, body: Data) -> StudioAPIError {
        if let decoded = try? StudioJSON.decoder().decode(APIErrorBody.self, from: body) {
            return .server(status: status, code: decoded.error.code, message: decoded.error.message, issues: decoded.error.issues ?? [])
        }
        if status == 401 || status == 403 { return .unauthorized(status: status) }
        return .http(status: status)
    }

    static func describe(_ error: DecodingError) -> String {
        func path(_ context: DecodingError.Context) -> String {
            context.codingPath.map { $0.intValue.map(String.init) ?? $0.stringValue }.joined(separator: ".")
        }
        switch error {
        case .keyNotFound(let key, let context): return "missing \(key.stringValue) at \(path(context))"
        case .typeMismatch(_, let context): return "type mismatch at \(path(context)): \(context.debugDescription)"
        case .valueNotFound(_, let context): return "null at \(path(context))"
        case .dataCorrupted(let context): return "corrupt data at \(path(context)): \(context.debugDescription)"
        @unknown default: return error.localizedDescription
        }
    }

    /// The server's code, when it answered with one.
    public var code: APIErrorCode? {
        if case .server(_, let code, _, _) = self { return code }
        return nil
    }

    public var isConnectivity: Bool {
        switch self {
        case .offline, .timedOut, .transport: true
        default: false
        }
    }

    /// Turkish message for the UI.
    public var errorDescription: String? {
        switch self {
        case .server(_, let code, let message, _):
            switch code {
            case .hashMismatch: return "Bu post sen bakarken değişti. Güncel sürümü kontrol edip yeniden onayla."
            case .invalidTransition: return "Bu işlem postun şu anki durumunda yapılamıyor."
            case .conflict: return "Çakışma: \(message)"
            case .notFound: return "Kayıt bulunamadı."
            case .payloadTooLarge: return "Dosya çok büyük."
            case .unsupportedMediaType: return "Bu dosya türü desteklenmiyor."
            case .validationError: return "Geçersiz istek: \(message)"
            case .unauthorized: return "Bu cihaz Mac ile eşleşmemiş ya da anahtarı iptal edilmiş. Yeniden eşleştir."
            case .forbidden: return "Bu işlem yalnızca Mac'te yapılabilir."
            case .rateLimited: return "Çok fazla hatalı deneme. Birkaç dakika sonra yeniden dene."
            case .internalError, .unknown: return "Sunucu hatası: \(message)"
            }
        case .unauthorized: return "Sunucu erişimi reddetti. Ayarlar'daki erişim anahtarını kontrol et."
        case .http(let status): return "Sunucu beklenmeyen bir yanıt verdi (HTTP \(status))."
        case .unexpectedResponse: return "Sunucudan beklenmeyen bir yanıt geldi."
        case .decoding: return "Sunucu yanıtı uygulamanın beklediği biçimde değil."
        case .offline: return "Sunucuya ulaşılamıyor."
        case .timedOut: return "Sunucu zamanında yanıt vermedi."
        case .transport(let message): return "Bağlantı hatası: \(message)"
        case .invalidConfiguration(let message): return message
        case .cancelled: return "İptal edildi."
        }
    }
}
