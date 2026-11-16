import Foundation
import Testing
@testable import StudioKit

@Suite("Brand kit (P2)")
struct BrandKitTests {
    private func client(_ handler: @escaping StubURLProtocol.Handler) -> (APIClient, String) {
        let host = uniqueHost()
        let session = StubURLProtocol.session(host: host, handler: handler)
        return (APIClient(baseURL: URL(string: "http://\(host):8787/")!, session: session), host)
    }

    private static let stored = #"""
    {"brandId":"b1","logos":[{"assetId":"l1","background":"dark","label":"Beyaz"},{"assetId":"l2","background":"light"}],
     "fonts":[{"assetId":"f1","family":"Archivo","role":"display","licenseNote":"SIL OFL"}],
     "palette":[{"name":"accent","hex":"#FF6A00","use":"tek vurgu"}],
     "samples":[{"assetId":"s1","caption":"Hasat"},{"assetId":"s2"}],
     "notes":"Siyah beyaz","updatedAt":"2026-11-16T10:00:00.000Z"}
    """#

    @Test func decodesAndRoundTripsTheKit() async throws {
        let (api, host) = client { _, _ in .init(status: 200, body: Data(Self.stored.utf8)) }
        let kit = try await api.brandKit(brandId: "b 1")
        #expect(kit.logos.map(\.background) == [.dark, .light])
        #expect(kit.fonts.first?.role == .display)
        #expect(kit.fonts.first?.licenseNote == "SIL OFL")
        #expect(kit.palette.first?.hex == "#FF6A00")
        #expect(kit.samples.count == 2)
        #expect(kit.updatedAt != nil)
        #expect(kit.analysisBlocker?.contains("şu an 2") == true)
        #expect(kit.assetIds == ["l1", "l2", "f1", "s1", "s2"])

        let request = try #require(StubURLProtocol.recorded(host: host).first?.0)
        #expect(request.url?.path == "/api/brands/b%201/kit" || request.url?.path == "/api/brands/b 1/kit")

        _ = try await api.saveBrandKit(brandId: "b1", kit.put)
        let (put, body) = try #require(StubURLProtocol.recorded(host: host).last)
        #expect(put.httpMethod == "PUT")
        #expect(put.url?.path == "/api/brands/b1/kit")
        let sent = try StudioJSON.decoder().decode(BrandKitPut.self, from: body)
        #expect(sent == kit.put)
        let json = try #require(String(data: body, encoding: .utf8))
        #expect(!json.contains("brandId"))
        #expect(!json.contains("updatedAt"))
    }

    @Test func emptyKitDecodesWithNullDate() throws {
        let json = #"{"brandId":"b","logos":[],"fonts":[],"palette":[],"samples":[],"notes":"","updatedAt":null}"#
        let kit = try StudioJSON.decoder().decode(BrandKit.self, from: Data(json.utf8))
        #expect(kit == .empty("b"))
        #expect(kit.analysisBlocker != nil)
    }

    @Test func rulesNormaliseColoursNamesAndFamilies() {
        #expect(BrandKitRules.normalizedHex("ff6a00") == "#FF6A00")
        #expect(BrandKitRules.normalizedHex("#f60") == "#FF6600")
        #expect(BrandKitRules.normalizedHex("orange") == nil)
        #expect(BrandKitRules.colorName("Ana Vurgu") == "ana-vurgu")
        #expect(BrandKitRules.colorName("1. renk") == nil)
        #expect(BrandKitRules.isValidFamily("Inter Display"))
        #expect(!BrandKitRules.isValidFamily("<script>"))
        #expect(BrandKitRules.familyGuess(fromFilename: "Archivo-BoldItalic.woff2") == "Archivo")
        #expect(BrandKitRules.familyGuess(fromFilename: "InterDisplay_Regular.ttf") == "Inter Display")
    }

    @Test func analyzeBrandSendsTheModelOnlyWhenChosen() async throws {
        let job = #"{"id":"j1","type":"brand.analyze","status":"queued","payload":{},"brandId":"b1","createdAt":"2026-11-16T10:00:00.000Z","updatedAt":"2026-11-16T10:00:00.000Z"}"#
        let (api, host) = client { _, _ in .init(status: 201, body: Data(job.utf8)) }
        _ = try await api.analyzeBrand(brandId: "b1")
        _ = try await api.analyzeBrand(brandId: "b1", notes: " not ", model: .sonnet)
        let bodies = StubURLProtocol.recorded(host: host).map { String(decoding: $0.1, as: UTF8.self) }
        #expect(!bodies[0].contains("model"))
        #expect(bodies[1].contains(#""model":"sonnet""#))
        #expect(bodies[1].contains(#""notes":"not""#))
    }

    @Test func sampleBackendStoresKitsAndRefusesForeignFiles() async throws {
        let backend = SampleBackend(data: SampleData(now: .now), uploadDelay: .zero)
        let brand = try await backend.createBrand(BrandCreate(name: "Kit Deneme"))
        let other = try #require(try await backend.brands().first { $0.id != brand.id })
        let mine = try await backend.uploadAsset(UploadFile(filename: "a.png", mimeType: "image/png", data: Data([1])), brandId: brand.id, kind: .image, progress: { _ in })
        let foreign = try await backend.uploadAsset(UploadFile(filename: "b.png", mimeType: "image/png", data: Data([1])), brandId: other.id, kind: .image, progress: { _ in })

        #expect(try await backend.brandKit(brandId: brand.id) == .empty(brand.id))
        let saved = try await backend.saveBrandKit(brandId: brand.id, BrandKitPut(palette: [BrandKitColor(name: "accent", hex: "#ff6a00")], samples: [BrandKitSample(assetId: mine.id)]))
        #expect(saved.palette.first?.hex == "#FF6A00")
        #expect(saved.updatedAt != nil)
        await #expect(throws: StudioAPIError.self) {
            _ = try await backend.saveBrandKit(brandId: brand.id, BrandKitPut(samples: [BrandKitSample(assetId: foreign.id)]))
        }

        _ = try await backend.updateBrand(brand.id, BrandUpdate(status: .archived))
        #expect(try await backend.archivedBrands().map(\.id).contains(brand.id))
        #expect(try await !backend.brands().map(\.id).contains(brand.id))
    }
}
