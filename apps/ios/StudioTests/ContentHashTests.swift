import Foundation
import Testing
@testable import Studio

@Suite("Content hash (computeContentHash parity)")
struct ContentHashTests {
    /// The fixture's slide HTML has quotes, a backslash, `/`, newline, tab,
    /// Turkish letters, an emoji and U+0001; the server computed its hash.
    @Test func matchesTheServerHashOfARealVersion() throws {
        let version = try Fixture.decode(ContentVersion.self, "version")
        #expect(ContentHash.compute(version.slides) == version.contentHash)
    }

    @Test func renderedAssetsDoNotAffectTheHash() throws {
        var version = try Fixture.decode(ContentVersion.self, "version")
        version.slides[1].renderedAssetId = "something-else"
        #expect(ContentHash.compute(version.slides) == version.contentHash)
    }

    @Test func anyEditChangesTheHash() throws {
        var version = try Fixture.decode(ContentVersion.self, "version")
        version.slides[0].html += " "
        #expect(ContentHash.compute(version.slides) != version.contentHash)
    }

    @Test(arguments: [
        ("a\"b", #""a\"b""#),
        ("a\\b", #""a\\b""#),
        ("a/b", #""a/b""#),
        ("\n\r\t\u{08}\u{0C}", #""\n\r\t\b\f""#),
        ("\u{01}\u{1F}", #""\u0001\u001f""#),
        ("çğİ🌾", "\"çğİ🌾\""),
        ("\u{7F}\u{2028}", "\"\u{7F}\u{2028}\""),
    ])
    func stringEscapingMatchesJSONStringify(input: String, expected: String) {
        #expect(ContentHash.jsString(input) == expected)
    }

    @Test func canonicalJSONKeyOrderIsWidthHeightHtml() {
        let slide = Slide(html: "<p>x</p>", width: 1080, height: 1350, renderedAssetId: nil)
        #expect(ContentHash.canonicalJSON([slide]) == #"[{"width":1080,"height":1350,"html":"<p>x</p>"}]"#)
    }
}
