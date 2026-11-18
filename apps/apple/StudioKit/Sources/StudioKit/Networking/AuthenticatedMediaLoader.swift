import AVFoundation
import Foundation
import UniformTypeIdentifiers

/// Streams a video from the Mac's API into `AVPlayer` with the paired device's headers (M5):
/// AVPlayer asks for byte ranges through an `AVAssetResourceLoader`, each range becomes one
/// `Range` request to `/api/assets/{id}/content` (the API answers 206). Nothing is written to
/// disk and the file is never held in memory as a whole.
///
/// The asset keeps only a weak reference to its loader: keep the loader alive as long as the
/// player plays (e.g. on the player view controller).
public final class AuthenticatedMediaLoader: NSObject, AVAssetResourceLoaderDelegate, @unchecked Sendable {
    public static let scheme = "studio-media"

    private let source: URL
    private let headers: [String: String]
    private let session: URLSession
    private let queue = DispatchQueue(label: "net.burakkoc.studio.media-loader")
    private let lock = NSLock()
    private var tasks: [ObjectIdentifier: Task<Void, Never>] = [:]
    /// Bytes handed to AVPlayer per call.
    static let chunk = 128 * 1024

    public init(source: URL, headers: [String: String], session: URLSession = .shared) {
        self.source = source
        self.headers = headers
        self.session = session
    }

    deinit {
        lock.lock()
        tasks.values.forEach { $0.cancel() }
        lock.unlock()
    }

    /// The asset to play (its URL uses `scheme`, so every read comes through this loader).
    public func makeAsset() -> AVURLAsset {
        var components = URLComponents(url: source, resolvingAgainstBaseURL: false)
        components?.scheme = Self.scheme
        let asset = AVURLAsset(url: components?.url ?? source)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    // MARK: Pure helpers (tested)

    /// `Range` header for AVPlayer's request (nil: the whole file).
    public static func rangeHeader(offset: Int64, length: Int, toEnd: Bool) -> String? {
        if toEnd || length <= 0 { return offset > 0 ? "bytes=\(offset)-" : nil }
        return "bytes=\(offset)-\(offset + Int64(length) - 1)"
    }

    /// Size of the whole file from `Content-Range: bytes a-b/total`, else the 200 body length.
    public static func totalLength(contentRange: String?, status: Int, expectedLength: Int64) -> Int64? {
        if let contentRange, let slash = contentRange.lastIndex(of: "/") {
            let total = contentRange[contentRange.index(after: slash)...].trimmingCharacters(in: .whitespaces)
            if let value = Int64(total) { return value }
        }
        return status == 200 && expectedLength > 0 ? expectedLength : nil
    }

    /// Uniform type for AVPlayer from the response's mime type (mp4 when unknown).
    public static func contentType(mimeType: String?) -> String {
        guard let mimeType, let type = UTType(mimeType: mimeType) else { return UTType.mpeg4Movie.identifier }
        return type.identifier
    }

    // MARK: AVAssetResourceLoaderDelegate

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader, shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest) -> Bool {
        let box = RequestBox(loadingRequest)
        let id = ObjectIdentifier(loadingRequest)
        let task = Task { [weak self] in
            await self?.serve(box)
            self?.forget(id)
        }
        lock.lock()
        tasks[id] = task
        lock.unlock()
        return true
    }

    public func resourceLoader(_ resourceLoader: AVAssetResourceLoader, didCancel loadingRequest: AVAssetResourceLoadingRequest) {
        let id = ObjectIdentifier(loadingRequest)
        lock.lock()
        let task = tasks.removeValue(forKey: id)
        lock.unlock()
        task?.cancel()
    }

    private func forget(_ id: ObjectIdentifier) {
        lock.lock()
        tasks[id] = nil
        lock.unlock()
    }

    /// `AVAssetResourceLoadingRequest` is used from the loader's queue only.
    private final class RequestBox: @unchecked Sendable {
        let request: AVAssetResourceLoadingRequest
        init(_ request: AVAssetResourceLoadingRequest) { self.request = request }
    }

    private func onQueue(_ work: @escaping @Sendable () -> Void) {
        queue.async(execute: work)
    }

    private func serve(_ box: RequestBox) async {
        let loading = box.request
        var request = URLRequest(url: source)
        request.timeoutInterval = 60
        for (name, value) in headers { request.setValue(value, forHTTPHeaderField: name) }
        var offset: Int64 = 0
        if let data = loading.dataRequest {
            offset = data.requestedOffset
            if let range = Self.rangeHeader(offset: offset, length: data.requestedLength, toEnd: data.requestsAllDataToEndOfResource) {
                request.setValue(range, forHTTPHeaderField: "Range")
            }
        } else {
            request.setValue("bytes=0-1", forHTTPHeaderField: "Range")
        }
        do {
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 || http.statusCode == 206 else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                throw StudioAPIError.http(status: status)
            }
            let total = Self.totalLength(contentRange: http.value(forHTTPHeaderField: "Content-Range"), status: http.statusCode, expectedLength: http.expectedContentLength)
            let type = Self.contentType(mimeType: http.mimeType)
            onQueue {
                if let info = loading.contentInformationRequest {
                    info.contentType = type
                    if let total { info.contentLength = total }
                    info.isByteRangeAccessSupported = true
                }
            }
            guard loading.dataRequest != nil else {
                onQueue { loading.finishLoading() }
                return
            }
            // A server that ignored `Range` sends the file from the start: skip to the offset.
            var skip = http.statusCode == 200 ? offset : 0
            var buffer = Data()
            buffer.reserveCapacity(Self.chunk)
            for try await byte in bytes {
                if skip > 0 {
                    skip -= 1
                    continue
                }
                buffer.append(byte)
                if buffer.count >= Self.chunk {
                    let piece = buffer
                    buffer.removeAll(keepingCapacity: true)
                    onQueue { loading.dataRequest?.respond(with: piece) }
                }
            }
            let rest = buffer
            onQueue {
                if !rest.isEmpty { loading.dataRequest?.respond(with: rest) }
                loading.finishLoading()
            }
        } catch {
            if Task.isCancelled { return }
            let failure = error
            onQueue { if !loading.isFinished && !loading.isCancelled { loading.finishLoading(with: failure) } }
        }
    }
}
