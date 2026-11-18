import CoreGraphics
import Foundation
import XCTest

@testable import VisionCore

final class VisionCoreTests: XCTestCase {
    func testVersionListsTurkishOcr() throws {
        let response = handle(HelperRequest(command: "version"))
        XCTAssertTrue(response.ok)
        guard case .version(let version) = response.result else { return XCTFail("no version") }
        XCTAssertEqual(version.helperVersion, helperVersion)
        XCTAssertTrue(version.ocrLanguages.contains("tr-TR"), "\(version.ocrLanguages)")
        XCTAssertGreaterThanOrEqual(version.featurePrintRevision, 1)
    }

    func testLanguageCodesResolve() {
        let supported = ["en-US", "tr-TR", "de-DE"]
        XCTAssertEqual(resolveLanguage("tr", supported: supported), "tr-TR")
        XCTAssertEqual(resolveLanguage("en", supported: supported), "en-US")
        XCTAssertEqual(resolveLanguage("TR-tr", supported: supported), "tr-TR")
        XCTAssertNil(resolveLanguage("xx", supported: supported))
    }

    func testOcrReadsTheLabelThroughTheJsonProtocol() throws {
        let photo = productPhoto()
        let path = try temporaryFile("label.png", try pngData(of: photo.image))
        let request = Data(
            #"{"command":"ocr","path":"\#(path)","languages":["tr","en"]}"#.utf8)
        let response = handle(json: request)
        XCTAssertTrue(response.ok, "\(String(describing: response.error))")
        XCTAssertEqual(response.image?.width, 900)
        guard case .ocr(let ocr) = response.result else { return XCTFail("no ocr") }
        XCTAssertEqual(ocr.languages, ["tr-TR", "en-US"])
        let text = folded(ocr.text)
        XCTAssertTrue(text.contains("venta"), text)
        XCTAssertTrue(text.contains("borinc"), text)
        XCTAssertTrue(text.contains("gubre"), text)
        XCTAssertTrue(text.contains("25 kg"), text)
        // Lines come back top to bottom, inside the bag.
        let first = try XCTUnwrap(ocr.lines.first)
        XCTAssertTrue(folded(first.text).contains("venta"))
        XCTAssertGreaterThan(first.box.y, photo.productRect.minY)
        XCTAssertLessThan(first.box.y + first.box.height, photo.productRect.maxY)
        // The whole response encodes as JSON with a top-left box.
        let json = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: encode(response)) as? [String: Any])
        XCTAssertEqual(json["ok"] as? Bool, true)
    }

    func testClassifyReturnsRankedLabels() throws {
        let result = try classify(landscape(), minConfidence: 0.01, maxLabels: 5)
        XCTAssertFalse(result.labels.isEmpty)
        XCTAssertLessThanOrEqual(result.labels.count, 5)
        let confidences = result.labels.map(\.confidence)
        XCTAssertEqual(confidences, confidences.sorted(by: >))
    }

    func testFeaturePrintDistanceMatchesVision() throws {
        let product = productPhoto().image
        let other = landscape()
        let a = try featurePrint(product)
        let b = try featurePrint(other)
        let again = try featurePrint(product)
        XCTAssertEqual(a.count, b.count)
        XCTAssertGreaterThan(a.count, 100)
        let va = decodeFeatureData(a.data)
        let vb = decodeFeatureData(b.data)
        XCTAssertEqual(va.count, a.count)
        XCTAssertLessThan(euclidean(va, decodeFeatureData(again.data)), 1e-4)
        let ours = euclidean(va, vb)
        let vision = try featureDistance(product, other)
        XCTAssertGreaterThan(ours, 0.1)
        XCTAssertEqual(ours, vision, accuracy: max(1e-3, vision * 1e-3))
        // A slightly different crop of the same product is closer than the landscape.
        let crop = product.cropping(to: CGRect(x: 20, y: 20, width: 860, height: 1085))!
        let near = euclidean(va, decodeFeatureData(try featurePrint(crop).data))
        XCTAssertLessThan(near, ours)
    }

    func testForegroundMaskCutsTheProductOutOfABusyBackdrop() throws {
        guard foregroundMaskAvailable else { throw XCTSkip("macOS 14+ only") }
        let photo = productPhoto()
        let output = FileManager.default.temporaryDirectory
            .appendingPathComponent("studio-vision-cutout-\(UUID().uuidString).png").path
        defer { try? FileManager.default.removeItem(atPath: output) }
        let result = try foregroundMask(photo.image, instances: "largest", crop: true, output: output)
        XCTAssertEqual(result.output, output)
        XCTAssertTrue(FileManager.default.fileExists(atPath: output))
        // The cutout is the bag: its box overlaps the drawn bag closely.
        let box = CGRect(x: result.box.x, y: result.box.y, width: result.box.width, height: result.box.height)
        let overlap = box.intersection(photo.productRect)
        let union = box.union(photo.productRect)
        let iou = (overlap.width * overlap.height) / (union.width * union.height)
        XCTAssertGreaterThan(iou, 0.6, "box \(box) vs \(photo.productRect)")
        XCTAssertGreaterThan(result.coverage, 0.15)
        // The PNG keeps alpha: corners are transparent, the label centre is opaque.
        let data = try Data(contentsOf: URL(fileURLWithPath: output))
        let cutout = try loadImage(data: data)
        XCTAssertEqual(cutout.width, result.width)
        let pixels = rgba(cutout)
        XCTAssertLessThan(pixels.alpha(0, 0), 20)
        XCTAssertGreaterThan(pixels.alpha(cutout.width / 2, cutout.height / 2), 240)
    }

    func testSaliencyGridIsNormalized() throws {
        let result = try saliency(productPhoto().image, columns: 8, rows: 10)
        XCTAssertEqual(result.columns, 8)
        XCTAssertEqual(result.rows, 10)
        XCTAssertEqual(result.grid.count, 80)
        XCTAssertEqual(result.grid.max() ?? 0, 1, accuracy: 1e-9)
        XCTAssertGreaterThanOrEqual(result.grid.min() ?? -1, 0)
    }

    func testAnalyzeRunsTheRequestedPartsTogether() throws {
        let path = try temporaryFile("analyze.png", try pngData(of: productPhoto().image))
        var request = HelperRequest(command: "analyze", path: path)
        request.ops = ["classify", "ocr", "feature-print", "nope"]
        let response = handle(request)
        XCTAssertTrue(response.ok)
        guard case .analyze(let result) = response.result else { return XCTFail("no analyze") }
        XCTAssertNotNil(result.classify)
        XCTAssertNotNil(result.ocr)
        XCTAssertNotNil(result.featurePrint)
        XCTAssertNil(result.saliency)
        XCTAssertEqual(result.errors["nope"]?.code, "bad_request")
    }

    func testFailuresComeBackAsCodes() {
        XCTAssertEqual(handle(json: Data("not json".utf8)).error?.code, "bad_request")
        XCTAssertEqual(handle(HelperRequest(command: "ocr")).error?.code, "bad_request")
        XCTAssertEqual(
            handle(HelperRequest(command: "ocr", path: "/nonexistent/x.png")).error?.code,
            "unreadable_image")
        let bogus = try? temporaryFile("bogus.png", Data("hello".utf8))
        XCTAssertEqual(handle(HelperRequest(command: "classify", path: bogus)).error?.code, "unreadable_image")
        let path = try? temporaryFile("ok.png", (try? pngData(of: landscape())) ?? Data())
        let unknown = handle(HelperRequest(command: "dance", path: path))
        XCTAssertFalse(unknown.ok)
        XCTAssertEqual(unknown.error?.code, "bad_request")
    }
}

struct RGBA {
    let width: Int
    let bytes: [UInt8]

    func alpha(_ x: Int, _ y: Int) -> UInt8 {
        bytes[(y * width + x) * 4 + 3]
    }
}

func rgba(_ image: CGImage) -> RGBA {
    let context = rgbContext(width: image.width, height: image.height)
    context.clear(CGRect(x: 0, y: 0, width: image.width, height: image.height))
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    let data = context.data!.assumingMemoryBound(to: UInt8.self)
    let count = context.bytesPerRow * image.height
    // Rows are padded to bytesPerRow; repack tightly (top row first in memory for CGBitmapContext).
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    for y in 0..<image.height {
        for x in 0..<(image.width * 4) {
            bytes[y * image.width * 4 + x] = data[y * context.bytesPerRow + x]
        }
    }
    _ = count
    return RGBA(width: image.width, bytes: bytes)
}
