// swift-tools-version: 6.0
//
// studio-vision: Studio's small on-device image helper on Apple's Vision framework (free, local,
// no network). The worker runs it once per request: one JSON object on stdin, one JSON object on
// stdout (Sources/VisionCore/Protocol.swift).
//
//   swift build -c release      → .build/release/studio-vision (the worker finds it there in dev)
//   swift test                  → VisionCoreTests (synthetic images, no fixtures on disk)
//
// The packaged Studio.app ships the release binary as Contents/Resources/host/bin/studio-vision
// (apps/desktop/scripts/build-host.mjs).
import PackageDescription

let package = Package(
    name: "StudioVision",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "studio-vision", targets: ["studio-vision"]),
    ],
    targets: [
        .target(name: "VisionCore", path: "Sources/VisionCore"),
        .executableTarget(
            name: "studio-vision",
            dependencies: ["VisionCore"],
            path: "Sources/studio-vision"
        ),
        .testTarget(
            name: "VisionCoreTests",
            dependencies: ["VisionCore"],
            path: "Tests/VisionCoreTests"
        ),
    ],
    swiftLanguageModes: [.v6]
)
