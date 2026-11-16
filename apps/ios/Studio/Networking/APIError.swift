import Foundation

/// Machine-readable error codes (`ErrorCode` in packages/contract/src/common.ts).
enum APIErrorCode: String, ResilientEnum {
    case validationError = "validation_error"
    case notFound = "not_found"
    case conflict
    case invalidTransition = "invalid_transition"
    case hashMismatch = "hash_mismatch"
    case payloadTooLarge = "payload_too_large"
    case unsupportedMediaType = "unsupported_media_type"
    case internalError = "internal_error"
    case unknown
}

/// `{ "error": { "code", "message", "issues"? } }` — every non-2xx response.
struct APIErrorBody: Decodable, Sendable, Equatable {
    struct Issue: Decodable, Sendable, Equatable, Hashable {
        /// Dotted path of the offending field, e.g. `slides.0.html`; "" for the root.
        var path: String
        var message: String
    }

    struct Detail: Decodable, Sendable, Equatable {
        var code: APIErrorCode
        var message: String
        var issues: [Issue]?
    }

    var error: Detail
}

/// The single error type every API call throws.
enum APIError: Error, Sendable, Equatable {
    /// The API answered with its error shape.
    case server(status: Int, code: APIErrorCode, message: String, issues: [APIErrorBody.Issue])
    /// 401/403 without the API error shape: Cloudflare Access refused the credentials.
    case unauthorized(status: Int)
    /// Non-2xx without the API error shape (proxy, gateway, ...).
    case http(status: Int)
    /// 2xx that is not the expected JSON, e.g. an Access login page (HTML).
    case unexpectedResponse(String)
    case decoding(String)
    /// No network, or the server cannot be reached.
    case offline
    case timedOut
    case transport(String)
    /// Base URL missing or malformed.
    case invalidConfiguration(String)
    case cancelled

    static func from(_ error: any Error) -> APIError {
        if let error = error as? APIError { return error }
        if error is CancellationError { return .cancelled }
        if let error = error as? URLError { return from(error) }
        return .transport(error.localizedDescription)
    }

    static func from(_ error: URLError) -> APIError {
        switch error.code {
        case .cancelled:
            return .cancelled
        case .timedOut:
            return .timedOut
        case .notConnectedToInternet, .networkConnectionLost, .cannotConnectToHost, .cannotFindHost,
             .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed, .callIsActive:
            return .offline
        case .appTransportSecurityRequiresSecureConnection:
            return .invalidConfiguration("Bu adres için https gerekiyor (yalnızca yerel ağ adresleri http kullanabilir).")
        case .userAuthenticationRequired:
            return .unauthorized(status: 401)
        default:
            return .transport(error.localizedDescription)
        }
    }

    /// Build the error for a non-2xx response.
    static func from(status: Int, body: Data) -> APIError {
        if let decoded = try? JSONDecoder().decode(APIErrorBody.self, from: body) {
            return .server(
                status: status, code: decoded.error.code, message: decoded.error.message,
                issues: decoded.error.issues ?? [])
        }
        if status == 401 || status == 403 { return .unauthorized(status: status) }
        return .http(status: status)
    }

    var code: APIErrorCode? {
        if case .server(_, let code, _, _) = self { return code }
        return nil
    }

    var isOffline: Bool {
        switch self {
        case .offline, .timedOut: return true
        default: return false
        }
    }
}

extension APIError: LocalizedError {
    /// Short Turkish title for alerts and error states.
    var title: String {
        switch self {
        case .offline: return "Sunucuya ulaşılamıyor"
        case .timedOut: return "Sunucu yanıt vermedi"
        case .unauthorized: return "Erişim reddedildi"
        case .invalidConfiguration: return "Sunucu adresi geçersiz"
        case .cancelled: return "İptal edildi"
        case .server(_, let code, _, _):
            switch code {
            case .validationError: return "Geçersiz bilgi"
            case .notFound: return "Bulunamadı"
            case .conflict, .invalidTransition: return "İşlem yapılamadı"
            case .hashMismatch: return "İçerik değişti"
            case .payloadTooLarge: return "Dosya çok büyük"
            case .unsupportedMediaType: return "Desteklenmeyen dosya"
            case .internalError, .unknown: return "Sunucu hatası"
            }
        default: return "Bir şeyler ters gitti"
        }
    }

    /// Turkish explanation; the server's English message is appended where it adds detail.
    var errorDescription: String? {
        switch self {
        case .offline:
            return "İnternet bağlantınızı ve Ayarlar'daki sunucu adresini kontrol edin."
        case .timedOut:
            return "İstek zaman aşımına uğradı. Biraz sonra tekrar deneyin."
        case .unauthorized:
            return "Cloudflare Access servis token'ını Ayarlar'dan kontrol edin."
        case .http(let status):
            return "Sunucu beklenmeyen bir durum kodu döndürdü (\(status))."
        case .unexpectedResponse:
            return "Sunucu beklenmeyen bir yanıt verdi. Adres yanlış olabilir ya da bir giriş sayfası araya girmiş olabilir."
        case .decoding:
            return "Sunucunun yanıtı okunamadı. Uygulama sunucudan eski olabilir."
        case .transport(let message):
            return "Bağlantı hatası: \(message)"
        case .invalidConfiguration(let message):
            return message
        case .cancelled:
            return "İstek iptal edildi."
        case .server(_, let code, let message, let issues):
            let base: String
            switch code {
            case .validationError: base = "Gönderilen bilgilerde hata var."
            case .notFound: base = "Aradığınız kayıt bulunamadı; silinmiş olabilir."
            case .conflict: base = "Bu işlem şu anki durumla çakışıyor."
            case .invalidTransition: base = "Bu işlem şu anki durumda yapılamaz."
            case .hashMismatch: base = "Siz bakarken içeriğin yeni bir sürümü geldi. Yeni sürümü inceleyip tekrar onaylayın."
            case .payloadTooLarge: base = "Dosya izin verilen boyuttan büyük."
            case .unsupportedMediaType: base = "Bu dosya türü desteklenmiyor."
            case .internalError, .unknown: base = "Sunucuda bir hata oluştu."
            }
            let details = issues.map { $0.path.isEmpty ? $0.message : "\($0.path): \($0.message)" }
            return ([base] + (details.isEmpty ? [message] : details)).joined(separator: "\n")
        }
    }
}
