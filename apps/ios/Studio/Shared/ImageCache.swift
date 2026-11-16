import UIKit

/// In-memory cache of decoded asset images (rendered slides). Requests for
/// the same asset share one download.
actor ImageCache {
    private var images: [String: UIImage] = [:]
    private var order: [String] = []
    private var inFlight: [String: Task<UIImage, any Error>] = [:]
    private let capacity: Int

    init(capacity: Int = 60) {
        self.capacity = capacity
    }

    func image(assetId: String, api: APIClient) async throws(APIError) -> UIImage {
        if let cached = images[assetId] { return cached }
        let task: Task<UIImage, any Error>
        if let existing = inFlight[assetId] {
            task = existing
        } else {
            task = Task {
                let data = try await api.assetContent(id: assetId)
                guard let image = await Self.decode(data) else {
                    throw APIError.unexpectedResponse("asset is not an image")
                }
                return image
            }
            inFlight[assetId] = task
        }
        do {
            let image = try await task.value
            inFlight[assetId] = nil
            store(image, for: assetId)
            return image
        } catch {
            inFlight[assetId] = nil
            throw APIError.from(error)
        }
    }

    func removeAll() {
        images = [:]
        order = []
        inFlight.values.forEach { $0.cancel() }
        inFlight = [:]
    }

    private func store(_ image: UIImage, for key: String) {
        if images[key] == nil { order.append(key) }
        images[key] = image
        while order.count > capacity {
            images[order.removeFirst()] = nil
        }
    }

    /// Decodes off the caller's executor so large JPEGs do not stall anything.
    @concurrent
    private static func decode(_ data: Data) async -> UIImage? {
        guard let image = UIImage(data: data) else { return nil }
        return await image.byPreparingForDisplay() ?? image
    }
}
