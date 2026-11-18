import Foundation

/// A file ready for `POST /api/assets`.
public struct UploadFile: Sendable, Equatable {
    public var filename: String
    public var mimeType: String
    /// The bytes; empty when `fileURL` holds them (videos are never read into memory).
    public var data: Data
    public var width: Int?
    public var height: Int?
    /// Length of a video or sound (`durationMs` form field).
    public var durationMs: Int?
    /// The file on disk to send instead of `data` (streamed into the request body).
    public var fileURL: URL?

    public init(filename: String, mimeType: String, data: Data, width: Int? = nil, height: Int? = nil, durationMs: Int? = nil) {
        self.filename = filename
        self.mimeType = mimeType
        self.data = data
        self.width = width
        self.height = height
        self.durationMs = durationMs
    }

    /// A file sent from disk.
    public init(filename: String, mimeType: String, fileURL: URL, width: Int? = nil, height: Int? = nil, durationMs: Int? = nil) {
        self.init(filename: filename, mimeType: mimeType, data: Data(), width: width, height: height, durationMs: durationMs)
        self.fileURL = fileURL
    }

    /// Bytes that will be sent.
    public var byteCount: Int {
        guard let fileURL else { return data.count }
        return ((try? FileManager.default.attributesOfItem(atPath: fileURL.path)[.size]) as? NSNumber)?.intValue ?? 0
    }

    public var isVideo: Bool { mimeType.lowercased().hasPrefix("video/") }

    /// The asset kind the server stores it as.
    public var assetKind: AssetKind {
        let mime = mimeType.lowercased()
        if mime.hasPrefix("video/") { return .video }
        if mime.hasPrefix("audio/") { return .audio }
        if mime == "application/pdf" { return .document }
        return .image
    }
}

/// `multipart/form-data` body builder.
public struct MultipartForm: Sendable {
    public let boundary: String
    private var body = Data()

    public init(boundary: String = "studio-\(UUID().uuidString)") {
        self.boundary = boundary
    }

    public var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    public mutating func addField(_ name: String, _ value: String) {
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(Self.escape(name))\"\r\n\r\n")
        body.append("\(value)\r\n")
    }

    public mutating func addFile(_ name: String, filename: String, mimeType: String, data: Data) {
        body.append("--\(boundary)\r\n")
        body.append("Content-Disposition: form-data; name=\"\(Self.escape(name))\"; filename=\"\(Self.escape(filename))\"\r\n")
        body.append("Content-Type: \(mimeType)\r\n\r\n")
        body.append(data)
        body.append("\r\n")
    }

    public func finalize() -> Data {
        var out = body
        out.append("--\(boundary)--\r\n")
        return out
    }

    /// Write the whole body to `destination`: the fields added so far, then one file part whose
    /// bytes are copied from `source` in chunks (never all in memory), then the closing boundary.
    public func writeBody(to destination: URL, fileField name: String, filename: String, mimeType: String, source: URL) throws {
        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let out = try FileHandle(forWritingTo: destination)
        defer { try? out.close() }
        var head = body
        head.append("--\(boundary)\r\n")
        head.append("Content-Disposition: form-data; name=\"\(Self.escape(name))\"; filename=\"\(Self.escape(filename))\"\r\n")
        head.append("Content-Type: \(mimeType)\r\n\r\n")
        try out.write(contentsOf: head)
        let input = try FileHandle(forReadingFrom: source)
        defer { try? input.close() }
        while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty {
            try out.write(contentsOf: chunk)
        }
        try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
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
