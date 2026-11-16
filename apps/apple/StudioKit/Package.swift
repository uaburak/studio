// swift-tools-version: 6.2
//
// StudioKit: everything the Studio apps share that is not UI.
// Models mirroring packages/contract, the API client, the live streams
// (jobs, conversations), worker presence, asset upload, and the services the
// macOS app (and later the iOS app) build their screens on.
//
// No third-party dependencies. Swift 6 language mode (complete strict
// concurrency checking).
import PackageDescription

let package = Package(
    name: "StudioKit",
    defaultLocalization: "tr",
    platforms: [.macOS(.v26), .iOS(.v26)],
    products: [
        .library(name: "StudioKit", targets: ["StudioKit"]),
    ],
    targets: [
        .target(
            name: "StudioKit",
            path: "Sources/StudioKit"
        ),
        .testTarget(
            name: "StudioKitTests",
            dependencies: ["StudioKit"],
            path: "Tests/StudioKitTests",
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
