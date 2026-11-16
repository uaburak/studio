import AppKit
import StudioKit
import Testing
@testable import StudioMac

enum ScreenshotSwitch {
    /// Off by default: the renderer opens windows, and the owner judges the UI on screen.
    static var enabled: Bool { ProcessInfo.processInfo.environment["STUDIO_RENDER_SCREENSHOTS"] == "1" }
}

/// Renders every approved screen (and the three sidebar states) from the real
/// AppKit views with sample data, in light and dark, at 1440x900, into
/// apps/apple/docs/screenshots/offscreen/{light,dark}/ (override with
/// STUDIO_SCREENSHOT_DIR). Opens windows, so it only runs with
/// STUDIO_RENDER_SCREENSHOTS=1. Offscreen renders flatten Liquid Glass and
/// materials; they are a layout aid, not a picture of the app.
@Suite("Screenshot renders", .serialized, .enabled(if: ScreenshotSwitch.enabled))
@MainActor
struct ScreenshotTests {
    static var outputDirectory: URL {
        if let custom = ProcessInfo.processInfo.environment["STUDIO_SCREENSHOT_DIR"], !custom.isEmpty {
            return URL(fileURLWithPath: custom)
        }
        // StudioMacTests/ScreenshotTests.swift -> apps/apple/docs/screenshots
        return URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "docs/screenshots/offscreen")
    }

    @Test(arguments: [false, true])
    func rendersEveryScene(dark: Bool) async throws {
        for scene in SnapshotScene.allCases {
            let url = Self.outputDirectory.appending(path: dark ? "dark" : "light").appending(path: scene.rawValue + ".png")
            try await SnapshotRenderer.render(scene, dark: dark, to: url)
            let image = try #require(NSImage(contentsOf: url))
            let rep = try #require(image.representations.first)
            #expect(rep.pixelsWide == 1440)
            #expect(rep.pixelsHigh == 900)
        }
    }
}
