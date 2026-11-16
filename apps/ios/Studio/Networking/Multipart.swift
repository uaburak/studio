import Foundation

/// A file ready for `POST /api/assets`.
struct UploadFile: Sendable, Equatable {
    var filename: String
    var mimeType: String
    var data: Data
    var width: Int?
    var height: Int?
    var durationMs: Int?
}

/// `multipart/form-data` body builder.
struct MultipartForm {
    let boundary: String
    private var body = Data()

    init(boundary: String = "studio-\(UUID().uuidString)") {
        self.boundary = boundary
    }

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    mutating func addField(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(Self.escape(name))\"\r\n\r\n")
        body.append("\(value)\r\n")
    }

    mutating func addFile(_ name: String, filename: String, mimeType: String, data: Data) {
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(Self.escape(name))\"; filename=\"\(Self.escape(filename))\"\r\n")
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.append("\r\n")
    }

    func finalize() -> Data {
        var out = body
        out.append("--\(boundary)--\r\n")
        return out
    }

    private static func escape(_ value: String) -> String {
        value.replacingOccurrences(of: "\"", with: "%22")
            .replacingOccurrences(of: "\r", with: "")
            .replacingOccurrences(of: "\n", with: "")
    }
}

private extension Data {
    mutating func append(_ string: String) { append(Data(string.utf8)) }
}

/// Task delegate that reports how much of the request body has been sent.
final class UploadProgressDelegate: NSObject, URLSessionTaskDelegate, Sendable {
    let onProgress: @Sendable (Double) -> Void

    init(onProgress: @escaping @Sendable (Double) -> Void) {
        self.onProgress = onProgress
    }

    func urlSession(
        _ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
        totalBytesSent: Int64, totalBytesExpectedToSend: Int64
    ) {
        guard totalBytesExpectedToSend > 0 else { return }
        // Keep the last few percent for the server's response (hashing, R2 write).
        onProgress(min(0.97, Double(totalBytesSent) / Double(totalBytesExpectedToSend)))
    }
}
